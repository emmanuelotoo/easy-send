import {
  api,
  ApiError,
  formatGHS,
  formatWhen,
  guessNetwork,
  h,
  hueFor,
  icon,
  initials,
  localDigits,
  moneyParts,
  NETWORK_LABELS,
  setUnauthorizedHandler,
  toast,
} from './lib.js';
import { createPasskey, getAssertion, passkeyError, passkeysSupported } from './webauthn.js';

const root = document.getElementById('app');

/** Everything the screens share. Money figures are refetched, never trusted from here for long. */
const state = {
  session: null,
  contacts: null,
  balance: null,
  transactions: null,
  /** Wallet top-up details from the quote response, keyed by transaction id. */
  funding: new Map(),
};

// --- Screen lifecycle ----------------------------------------------------------------

let generation = 0;
let teardown = null;

/** Returns a check that turns false once the user has moved to another screen. */
function begin() {
  teardown?.();
  teardown = null;
  const mine = ++generation;
  return () => mine === generation;
}

function show(screen, activeTab) {
  root.replaceChildren(...[screen, activeTab ? tabBar(activeTab) : null].filter(Boolean));
  window.scrollTo(0, 0);
}

function parseHash() {
  const raw = location.hash.replace(/^#/, '') || '/';
  const [path, qs = ''] = raw.split('?');
  return { path, query: new URLSearchParams(qs) };
}

function go(hash) {
  if (location.hash === hash || (hash === '#/' && !location.hash)) render();
  else location.hash = hash;
}

function render() {
  if (!state.session?.authenticated) return gateScreen();
  const { path, query } = parseHash();
  const tx = path.match(/^\/tx\/(\d+)$/);
  if (tx) return txScreen(Number(tx[1]));
  if (path === '/send') return sendScreen(query);
  if (path === '/activity') return activityScreen();
  if (path === '/contacts') return contactsScreen();
  return homeScreen();
}

function fail(err) {
  toast(err instanceof ApiError ? err.message : passkeyError(err), 'error');
}

/** Put a button into a busy state while an async action runs. */
async function busy(button, action) {
  if (button.disabled) return;
  const label = [...button.childNodes];
  button.disabled = true;
  button.replaceChildren(h('span', { class: 'spinner' }));
  try {
    return await action();
  } finally {
    button.disabled = false;
    button.replaceChildren(...label);
  }
}

// --- Shared pieces -------------------------------------------------------------------

function tabBar(active) {
  const tab = (id, href, label, iconName) =>
    h('a', { class: 'tab', href, 'aria-current': active === id ? 'page' : null }, icon(iconName, 23), label);
  return h(
    'nav',
    { class: 'tabs', 'aria-label': 'Main' },
    h(
      'div',
      { class: 'tabs-inner' },
      tab('home', '#/', 'Home', 'home'),
      tab('activity', '#/activity', 'Activity', 'activity'),
      tab('contacts', '#/contacts', 'Contacts', 'contacts')
    )
  );
}

function avatar(name, network, size = '') {
  const el = h(
    'span',
    { class: `avatar ${size}`, 'aria-hidden': 'true' },
    initials(name),
    network ? h('span', { class: `net-dot net-${network}` }) : null
  );
  el.style.setProperty('--hue', hueFor(name));
  return el;
}

function netTag(network, label) {
  return h('span', { class: `net-tag net-${network}` }, label || NETWORK_LABELS[network] || 'Unknown network');
}

function topbar(title, { back, action } = {}) {
  return h(
    'header',
    { class: 'topbar' },
    back ? h('button', { class: 'icon-btn back', 'aria-label': 'Back', onclick: back }, icon('back', 24)) : null,
    h('h1', {}, title),
    action || null
  );
}

const STATUS = {
  quoted: ['Awaiting you', 'wait'],
  funding: ['Topping up', 'wait'],
  funding_otp: ['Needs code', 'wait'],
  sending: ['Sending', 'wait'],
  otp: ['Needs code', 'wait'],
  pending: ['On its way', 'wait'],
  success: ['Sent', 'ok'],
  failed: ['Failed', 'bad'],
  reversed: ['Returned', 'bad'],
  cancelled: ['Cancelled', ''],
  expired: ['Expired', ''],
};
const IN_FLIGHT = ['funding', 'funding_otp', 'sending', 'otp', 'pending'];

function txRow(tx) {
  const [label, tone] = STATUS[tx.status] || [tx.status, ''];
  return h(
    'button',
    { class: 'row', onclick: () => go(`#/tx/${tx.id}`) },
    avatar(tx.recipientName, tx.network, 'sm'),
    h(
      'span',
      { class: 'row-main' },
      h('span', { class: 'row-title' }, tx.recipientName),
      h('span', { class: 'row-sub' }, formatWhen(tx.createdAt))
    ),
    h(
      'span',
      { class: 'row-end' },
      h('span', { class: 'row-amount' }, formatGHS(tx.amountPesewas)),
      h('span', { class: `chip ${tone ? `chip-${tone}` : ''}` }, label)
    )
  );
}

async function loadContacts() {
  state.contacts = (await api('GET', '/api/contacts')).contacts;
  return state.contacts;
}

// --- Sign-in --------------------------------------------------------------------------

function gateScreen(pairing = false) {
  begin();
  const { setupRequired, enrollmentOpen } = state.session;
  const logo = h('img', { class: 'gate-logo', src: '/icons/icon.svg', alt: '' });
  const unsupported = passkeysSupported()
    ? null
    : h('div', { class: 'note bad' }, icon('alert'), h('span', {}, passkeyError()));

  if (setupRequired || pairing) {
    const code = h('input', {
      class: 'input',
      id: 'setup-code',
      type: 'password',
      autocomplete: 'off',
      autocapitalize: 'off',
      required: true,
      placeholder: 'Setup code',
    });
    const submit = h('button', { class: 'btn btn-primary', type: 'submit' }, icon('key', 20), 'Create passkey');
    const form = h(
      'form',
      {
        class: 'gate-form',
        onsubmit: event => {
          event.preventDefault();
          busy(submit, async () => {
            try {
              const setupCode = code.value.trim();
              const options = await api('POST', '/api/auth/register/options', { setupCode });
              const response = await createPasskey(options);
              await api('POST', '/api/auth/register/verify', { setupCode, response });
              state.session = await api('GET', '/api/session');
              toast('This device is paired.');
              render();
            } catch (err) {
              fail(err);
            }
          });
        },
      },
      h('div', { class: 'field' }, h('label', { for: 'setup-code' }, 'Setup code'), code),
      submit,
      pairing && !setupRequired
        ? h('button', { class: 'btn btn-quiet', type: 'button', onclick: () => gateScreen() }, 'Back')
        : null
    );
    show(
      h(
        'main',
        { class: 'gate' },
        logo,
        h('h1', {}, setupRequired ? ['Set up ', h('span', { class: 'nowrap' }, 'Easy-Send')] : 'Pair this device'),
        h(
          'p',
          {},
          'Enter the SETUP_CODE from your server settings. This device then creates a passkey, ' +
            'so only your fingerprint, face or screen lock can open the app and approve a send.'
        ),
        unsupported,
        form
      )
    );
    code.focus();
    return;
  }

  const unlock = h('button', { class: 'btn btn-primary' }, icon('lock', 20), 'Unlock');
  unlock.addEventListener('click', () =>
    busy(unlock, async () => {
      try {
        const options = await api('POST', '/api/auth/login/options', {});
        const response = await getAssertion(options);
        await api('POST', '/api/auth/login/verify', { response });
        state.session = await api('GET', '/api/session');
        render();
      } catch (err) {
        fail(err);
      }
    })
  );

  show(
    h(
      'main',
      { class: 'gate' },
      logo,
      h('h1', {}, 'Easy-Send'),
      h('p', {}, 'Unlock with your passkey to send money.'),
      unsupported,
      h(
        'div',
        { class: 'gate-form' },
        unlock,
        enrollmentOpen
          ? h('button', { class: 'btn btn-quiet', onclick: () => gateScreen(true) }, 'Pair a new device')
          : null
      )
    )
  );
}

async function lock() {
  await api('POST', '/api/auth/logout', {}).catch(() => {});
  Object.assign(state, { contacts: null, balance: null, transactions: null });
  state.funding.clear();
  state.session = { ...state.session, authenticated: false };
  location.hash = '#/';
  render();
}

// --- Home -----------------------------------------------------------------------------

function balanceCard(balance) {
  const card = h('section', { class: 'balance', 'aria-label': 'Paystack balance' });
  const label = h('div', { class: 'balance-label' }, 'Paystack balance');

  if (!balance) {
    card.append(label, h('div', { class: 'balance-amount' }, h('span', { class: 'skeleton' }, '0')));
    return card;
  }

  if (balance.balancePesewas === null) {
    card.append(label, h('div', { class: 'balance-amount' }, 'Unavailable'));
    card.append(h('div', { class: 'balance-note' }, 'Could not reach Paystack just now'));
  } else {
    const { whole, frac } = moneyParts(balance.balancePesewas);
    card.append(
      label,
      h('div', { class: 'balance-amount' }, h('span', { class: 'cur' }, 'GHS'), whole, h('span', { class: 'frac' }, `.${frac}`))
    );
    if (balance.low) {
      card.append(
        h(
          'div',
          { class: 'balance-note' },
          'Running low. Top up on the Paystack dashboard.'
        )
      );
    }
  }

  const { spentTodayPesewas, dailyPesewas } = balance.limits;
  const bar = h('span');
  bar.style.width = `${Math.min(100, (spentTodayPesewas / dailyPesewas) * 100)}%`;
  card.append(
    h(
      'div',
      { class: 'limit' },
      h(
        'div',
        { class: 'limit-row' },
        h('span', {}, 'Sent today'),
        h('span', { class: 'num' }, `${formatGHS(spentTodayPesewas)} of ${formatGHS(dailyPesewas)}`)
      ),
      h('div', { class: 'meter' }, bar)
    )
  );
  return card;
}

function peopleGrid(contacts) {
  const newNumber = h(
    'button',
    { class: 'person', onclick: () => go('#/send') },
    h('span', { class: 'avatar dashed', 'aria-hidden': 'true' }, icon('dial', 24)),
    h('span', { class: 'person-name' }, 'New number')
  );
  const tiles = contacts.slice(0, 7).map(c =>
    h(
      'button',
      { class: 'person', 'aria-label': `Send to ${c.nickname}`, onclick: () => go(`#/send?contact=${c.id}`) },
      avatar(c.nickname, c.network),
      h('span', { class: 'person-name' }, c.nickname)
    )
  );
  return h('div', { class: 'people' }, newNumber, tiles);
}

async function runCommand(text) {
  const result = await api('POST', '/api/command', { text });
  switch (result.action) {
    case 'send': {
      const target = result.contactId ? `contact=${result.contactId}` : `phone=${encodeURIComponent(result.phone)}`;
      return go(`#/send?${target}&amount=${encodeURIComponent(result.amount)}`);
    }
    case 'unknown_contact':
      toast(`No contact called "${result.name}". Add them first.`, 'error');
      return go('#/contacts');
    case 'contact_added':
      state.contacts = null;
      toast(`Added ${result.contact.nickname}.`);
      return go('#/contacts');
    case 'activity':
      return go('#/activity');
    case 'contacts':
      return go('#/contacts');
    default:
      return go('#/');
  }
}

async function homeScreen() {
  const alive = begin();

  const balanceSlot = h('div', {}, balanceCard(state.balance));
  const peopleSlot = h('div', {}, state.contacts ? peopleGrid(state.contacts) : null);
  const recentSlot = h('div', {});

  const paintRecent = () => {
    const recent = (state.transactions || []).slice(0, 4);
    recentSlot.replaceChildren(
      recent.length
        ? h('div', { class: 'list' }, recent.map(txRow))
        : state.transactions
          ? h('div', { class: 'empty' }, h('strong', {}, 'Nothing sent yet'), 'Pick someone above to make your first send.')
          : ''
    );
  };
  paintRecent();

  const input = h('input', {
    type: 'text',
    placeholder: 'Try "send 50 to Kojo"',
    'aria-label': 'Type a command',
    autocomplete: 'off',
    autocapitalize: 'off',
    enterKeyHint: 'go',
  });
  const submit = h('button', { type: 'submit', 'aria-label': 'Run command' }, icon('arrow', 20));
  const command = h(
    'form',
    {
      class: 'command',
      onsubmit: event => {
        event.preventDefault();
        const text = input.value.trim();
        if (text) busy(submit, () => runCommand(text).catch(fail));
      },
    },
    input,
    submit
  );

  show(
    h(
      'main',
      { class: 'screen has-tabs' },
      h(
        'header',
        { class: 'topbar' },
        h('h1', { class: 'wordmark' }, h('img', { src: '/icons/icon.svg', alt: '' }), 'Easy-Send'),
        h('button', { class: 'icon-btn', 'aria-label': 'Lock the app', title: 'Lock', onclick: lock }, icon('lock'))
      ),
      balanceSlot,
      command,
      h('section', {}, h('div', { class: 'section-head' }, h('h2', {}, 'Send to')), peopleSlot),
      h(
        'section',
        {},
        h('div', { class: 'section-head' }, h('h2', {}, 'Recent'), h('a', { class: 'link', href: '#/activity' }, 'See all')),
        recentSlot
      )
    ),
    'home'
  );

  api('GET', '/api/balance')
    .then(balance => {
      state.balance = balance;
      if (alive()) balanceSlot.replaceChildren(balanceCard(balance));
    })
    .catch(() => {});
  loadContacts()
    .then(contacts => alive() && peopleSlot.replaceChildren(peopleGrid(contacts)))
    .catch(err => alive() && fail(err));
  api('GET', '/api/transactions?limit=30')
    .then(({ transactions }) => {
      state.transactions = transactions;
      if (alive()) paintRecent();
    })
    .catch(() => {});
}

// --- Send: who and how much --------------------------------------------------------------

async function sendScreen(query) {
  const alive = begin();
  const contactId = Number(query.get('contact')) || null;

  if (contactId && !state.contacts) {
    try {
      await loadContacts();
    } catch (err) {
      fail(err);
    }
    if (!alive()) return;
  }
  const contact = contactId ? (state.contacts || []).find(c => c.id === contactId) : null;
  if (contactId && !contact) {
    toast('That contact no longer exists.', 'error');
    return go('#/');
  }

  // Who
  let who;
  let phone = null;
  const phoneHint = h('div', { class: 'hint' });
  if (contact) {
    who = h(
      'div',
      { class: 'recipient' },
      avatar(contact.nickname, contact.network, 'sm'),
      h(
        'div',
        { class: 'row-main' },
        h('div', { class: 'row-title' }, contact.nickname),
        h('div', { class: 'row-sub' }, contact.phone, ' · ', netTag(contact.network, contact.networkLabel))
      )
    );
  } else {
    phone = h('input', {
      class: 'input num',
      id: 'phone',
      type: 'tel',
      inputMode: 'tel',
      autocomplete: 'off',
      placeholder: '024 123 4567',
      value: query.get('phone') || '',
    });
    who = h('div', { class: 'field' }, h('label', { for: 'phone' }, 'Mobile money number'), phone, phoneHint);
  }

  // How much
  const amount = h('input', {
    class: 'amount-input',
    id: 'amount',
    type: 'text',
    inputMode: 'decimal',
    autocomplete: 'off',
    placeholder: '0',
    'aria-label': 'Amount in cedis',
    value: (query.get('amount') || '').replace(/\.00$/, ''),
  });
  const limitHint = h('div', { class: 'hint center' });
  const review = h('button', { class: 'btn btn-primary', type: 'submit' }, 'Review');

  const validPhone = () => {
    if (!phone) return true;
    const digits = localDigits(phone.value);
    return digits.length === 10 && !!guessNetwork(digits);
  };

  const sync = () => {
    // Keep the amount to digits with at most two decimals.
    const cleaned = amount.value
      .replace(/[^\d.]/g, '')
      .replace(/^(\d*\.?\d{0,2}).*$/, '$1')
      .replace(/^0+(?=\d)/, '');
    if (cleaned !== amount.value) amount.value = cleaned;
    amount.style.width = `${Math.max(amount.value.length, 1) + 0.6}ch`;

    if (phone) {
      const digits = localDigits(phone.value);
      const network = guessNetwork(digits);
      phoneHint.classList.toggle('bad', digits.length >= 3 && !network);
      phoneHint.replaceChildren(
        digits.length < 3 ? '' : network ? netTag(network) : 'Not an MTN, Telecel or AirtelTigo number'
      );
    }

    const pesewas = Math.round(Number(amount.value || 0) * 100);
    const limits = state.balance?.limits;
    let problem = '';
    if (limits && pesewas > limits.perTransactionPesewas) {
      problem = `Your limit is ${formatGHS(limits.perTransactionPesewas)} per send.`;
    } else if (limits && pesewas > limits.dailyPesewas - limits.spentTodayPesewas) {
      problem = `Only ${formatGHS(Math.max(0, limits.dailyPesewas - limits.spentTodayPesewas))} left in today's limit.`;
    }
    limitHint.classList.toggle('bad', !!problem);
    limitHint.textContent =
      problem || (limits ? `Up to ${formatGHS(limits.perTransactionPesewas)} per send, plus a GHS 1.00 fee.` : '');
    review.disabled = !(pesewas > 0) || !!problem || !validPhone();
  };

  amount.addEventListener('input', sync);
  phone?.addEventListener('input', sync);

  const quick = h(
    'div',
    { class: 'quick', role: 'group', 'aria-label': 'Quick amounts' },
    [10, 20, 50, 100].map(value =>
      h(
        'button',
        {
          type: 'button',
          onclick: () => {
            amount.value = String(value);
            sync();
          },
        },
        String(value)
      )
    )
  );

  const form = h(
    'form',
    {
      class: 'screen',
      onsubmit: event => {
        event.preventDefault();
        busy(review, async () => {
          try {
            const quote = await api('POST', '/api/quotes', {
              amount: amount.value,
              contactId: contact?.id ?? null,
              phone: phone ? localDigits(phone.value) : null,
            });
            state.funding.set(quote.transaction.id, quote.funding);
            go(`#/tx/${quote.transaction.id}`);
          } catch (err) {
            fail(err);
          }
        });
      },
    },
    topbar('Send money', { back: () => go('#/') }),
    who,
    h('div', {}, h('div', { class: 'amount-box' }, h('label', { class: 'cur', for: 'amount' }, 'GHS'), amount), limitHint),
    quick,
    h('div', { class: 'actions' }, review)
  );

  show(form);
  sync();
  (phone && !phone.value ? phone : amount).focus();

  if (!state.balance) {
    api('GET', '/api/balance')
      .then(balance => {
        state.balance = balance;
        if (alive()) sync();
      })
      .catch(() => {});
  }
}

// --- Review, confirm and receipt -----------------------------------------------------------

function fact(label, value, extraClass = '') {
  return h('div', { class: `fact ${extraClass}` }, h('dt', {}, label), h('dd', {}, value));
}

function heroAmount(pesewas) {
  const { whole, frac } = moneyParts(pesewas);
  return h('div', { class: 'hero-amount' }, h('span', { class: 'cur' }, 'GHS'), whole, h('span', { class: 'frac' }, `.${frac}`));
}

function retryHash(tx) {
  const amount = (tx.amountPesewas / 100).toFixed(2);
  if (tx.contactId) return `#/send?contact=${tx.contactId}&amount=${amount}`;
  if (tx.phone) return `#/send?phone=${encodeURIComponent(localDigits(tx.phone))}&amount=${amount}`;
  return '#/send';
}

async function txScreen(id) {
  const alive = begin();
  let timer = null;
  let countdown = null;
  let lastPaint = '';
  teardown = () => {
    clearTimeout(timer);
    clearInterval(countdown);
  };

  const poll = () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      if (!alive()) return;
      try {
        const { transaction } = await api('GET', `/api/transactions/${id}`);
        if (alive()) paint(transaction);
      } catch {
        if (alive()) poll();
      }
    }, 1500);
  };

  function paint(tx) {
    if (IN_FLIGHT.includes(tx.status)) poll();
    // Skip repainting when nothing changed, so a half-typed code is not wiped.
    const snapshot = JSON.stringify(tx);
    if (snapshot === lastPaint) return;
    lastPaint = snapshot;
    clearInterval(countdown);
    if (tx.status === 'quoted') paintReview(tx);
    else paintReceipt(tx);
  }

  // Review: the last look before money moves.
  function paintReview(tx) {
    const funding = state.funding.get(tx.id) || null;
    const blocked = funding && !funding.autoFund;

    const confirm = h('button', { class: 'btn btn-primary', disabled: !!blocked }, icon('shield', 20), 'Confirm and send');
    confirm.addEventListener('click', () =>
      busy(confirm, async () => {
        try {
          const options = await api('POST', `/api/transactions/${id}/confirm/options`, {});
          const response = await getAssertion(options);
          const { transaction } = await api('POST', `/api/transactions/${id}/confirm`, { response });
          state.balance = null;
          state.transactions = null;
          if (alive()) paint(transaction);
        } catch (err) {
          fail(err);
          // The quote may have expired or been used; show its real state.
          if (err instanceof ApiError && [409, 410].includes(err.status) && alive()) {
            api('GET', `/api/transactions/${id}`).then(r => alive() && paint(r.transaction)).catch(() => {});
          }
        }
      })
    );

    const cancel = async () => {
      await api('POST', `/api/transactions/${id}/cancel`, {}).catch(() => {});
      go(retryHash(tx));
    };

    const expiry = h('p', { class: 'hint center num' });
    const tick = () => {
      const left = Math.max(0, tx.expiresAt - Date.now());
      const minutes = Math.floor(left / 60000);
      const seconds = String(Math.floor((left % 60000) / 1000)).padStart(2, '0');
      expiry.textContent = `This quote holds for ${minutes}:${seconds}`;
      if (left <= 0) {
        clearInterval(countdown);
        api('GET', `/api/transactions/${id}`).then(r => alive() && paint(r.transaction)).catch(() => {});
      }
    };
    tick();
    countdown = setInterval(tick, 1000);

    const notes = [];
    if (!tx.verifiedName) {
      notes.push(
        h(
          'div',
          { class: 'note' },
          icon('alert'),
          h('span', {}, 'Paystack could not confirm who owns this number. Check it carefully before you send.')
        )
      );
    }
    if (funding) {
      notes.push(
        funding.autoFund
          ? h(
              'div',
              { class: 'note' },
              icon('alert'),
              h(
                'span',
                {},
                `Your Paystack balance is ${formatGHS(funding.balancePesewas)}, so about ` +
                  `${formatGHS(funding.chargeAmountPesewas)} will be pulled from your MoMo wallet first. ` +
                  `That costs about ${formatGHS(funding.extraFeePesewas)} more than topping up on the Paystack dashboard.`
              )
            )
          : h(
              'div',
              { class: 'note bad' },
              icon('alert'),
              h(
                'span',
                {},
                `Your Paystack balance is ${formatGHS(funding.balancePesewas)}, which does not cover this send. ` +
                  'Top up on the Paystack dashboard, then try again.'
              )
            )
      );
    }

    show(
      h(
        'main',
        { class: 'screen' },
        topbar('Review', { back: cancel }),
        h(
          'div',
          { class: 'hero' },
          h('p', { class: 'muted' }, "You're sending"),
          heroAmount(tx.amountPesewas),
          h('p', {}, 'to ', h('strong', {}, tx.recipientName))
        ),
        h(
          'dl',
          { class: 'facts' },
          tx.verifiedName
            ? fact('Registered name', h('span', { class: 'verified' }, icon('shield', 17), tx.verifiedName))
            : null,
          fact('Number', [tx.phone, ' · ', netTag(tx.network, tx.networkLabel)]),
          fact('Amount', formatGHS(tx.amountPesewas)),
          fact('Paystack fee', formatGHS(tx.feePesewas)),
          fact('Leaves your balance', formatGHS(tx.amountPesewas + tx.feePesewas), 'total')
        ),
        notes,
        h('div', { class: 'actions' }, expiry, confirm, h('button', { class: 'btn btn-quiet', onclick: cancel }, 'Cancel'))
      )
    );
  }

  // Receipt: everything after confirmation, live while the transfer is in flight.
  function paintReceipt(tx) {
    const amount = formatGHS(tx.amountPesewas);
    const spinner = () => h('span', { class: 'spinner' });
    const views = {
      funding: ['wait', spinner(), 'Topping up your balance', tx.prompt || 'Approve the payment prompt on your phone.'],
      funding_otp: ['wait', icon('key', 36), 'Enter the code', tx.prompt],
      otp: ['wait', icon('key', 36), 'Enter the Paystack code', tx.prompt],
      sending: ['wait', spinner(), 'Sending', `Handing ${amount} to Paystack.`],
      pending: ['wait', spinner(), 'On its way', `The network is delivering ${amount} to ${tx.recipientName}.`],
      success: ['ok', icon('check', 44), 'Sent', `${amount} sent to ${tx.recipientName}.`],
      failed: ['bad', icon('x', 40), 'Not sent', tx.failureReason || 'This transfer did not go through.'],
      reversed: ['bad', icon('returned', 38), 'Returned', tx.failureReason || 'The transfer was returned to your balance.'],
      cancelled: ['', icon('x', 40), 'Cancelled', 'This send was cancelled. No money moved.'],
      expired: ['', icon('x', 40), 'Quote expired', 'You did not confirm in time. No money moved.'],
    };
    const [tone, glyph, title, text] = views[tx.status] || ['', icon('alert', 38), tx.status, ''];

    let otpForm = null;
    if (tx.status === 'otp' || tx.status === 'funding_otp') {
      const code = h('input', {
        class: 'input otp-input',
        inputMode: 'numeric',
        autocomplete: 'one-time-code',
        maxLength: 8,
        placeholder: '······',
        'aria-label': 'One-time code',
        required: true,
      });
      const submit = h('button', { class: 'btn btn-primary', type: 'submit' }, 'Submit code');
      otpForm = h(
        'form',
        {
          class: 'gate-form',
          onsubmit: event => {
            event.preventDefault();
            busy(submit, async () => {
              try {
                const { transaction } = await api('POST', `/api/transactions/${id}/otp`, { otp: code.value });
                if (alive()) paint(transaction);
              } catch (err) {
                fail(err);
              }
            });
          },
        },
        code,
        submit
      );
    }

    const done = IN_FLIGHT.includes(tx.status) ? 'Close' : 'Done';
    const canRetry = ['failed', 'reversed', 'expired', 'cancelled'].includes(tx.status);

    show(
      h(
        'main',
        { class: 'screen' },
        h(
          'div',
          { class: 'hero', role: 'status', 'aria-live': 'polite' },
          h('div', { class: `badge ${tone ? `badge-${tone}` : ''}` }, glyph),
          h('h1', { class: 'hero-title' }, title),
          h('p', { class: 'muted' }, text)
        ),
        otpForm,
        h(
          'dl',
          { class: 'facts' },
          fact('To', tx.verifiedName && tx.verifiedName !== tx.recipientName ? `${tx.recipientName} (${tx.verifiedName})` : tx.recipientName),
          tx.phone ? fact('Number', [tx.phone, ' · ', netTag(tx.network, tx.networkLabel)]) : null,
          fact('Amount', amount),
          tx.feePesewas ? fact('Paystack fee', formatGHS(tx.feePesewas)) : null,
          tx.chargeAmountPesewas ? fact('Pulled from wallet', formatGHS(tx.chargeAmountPesewas)) : null,
          fact('When', formatWhen(tx.createdAt)),
          tx.reference ? fact('Reference', h('span', { class: 'mono' }, tx.reference)) : null
        ),
        h(
          'div',
          { class: 'actions' },
          canRetry ? h('button', { class: 'btn btn-primary', onclick: () => go(retryHash(tx)) }, 'Try again') : null,
          h('button', { class: `btn ${canRetry ? 'btn-quiet' : 'btn-primary'}`, onclick: () => go('#/') }, done)
        )
      )
    );
    otpForm?.querySelector('input').focus();
  }

  try {
    const { transaction } = await api('GET', `/api/transactions/${id}`);
    if (alive()) paint(transaction);
  } catch (err) {
    if (!alive()) return;
    fail(err);
    go('#/');
  }
}

// --- Activity ------------------------------------------------------------------------------

async function activityScreen() {
  const alive = begin();
  const slot = h('div', {});
  const paint = () => {
    const list = state.transactions;
    slot.replaceChildren(
      !list
        ? h('div', { class: 'boot' }, h('span', { class: 'spinner muted' }))
        : list.length
          ? h('div', { class: 'list' }, list.map(txRow))
          : h('div', { class: 'empty' }, h('strong', {}, 'No activity yet'), 'Sends show up here with their live status.')
    );
  };
  paint();
  show(h('main', { class: 'screen has-tabs' }, topbar('Activity'), slot), 'activity');

  try {
    state.transactions = (await api('GET', '/api/transactions?limit=100')).transactions;
    if (alive()) paint();
  } catch (err) {
    if (alive()) fail(err);
  }
}

// --- Contacts ------------------------------------------------------------------------------

function contactDialog(contact, onSaved) {
  const name = h('input', {
    class: 'input',
    id: 'contact-name',
    autocomplete: 'off',
    maxLength: 40,
    required: true,
    placeholder: 'Kojo',
    value: contact?.nickname || '',
  });
  const phone = h('input', {
    class: 'input num',
    id: 'contact-phone',
    type: 'tel',
    inputMode: 'tel',
    autocomplete: 'off',
    required: true,
    placeholder: '024 123 4567',
    value: contact?.phone || '',
  });
  const hint = h('div', { class: 'hint' });
  const syncHint = () => {
    const digits = localDigits(phone.value);
    const network = guessNetwork(digits);
    hint.classList.toggle('bad', digits.length >= 3 && !network);
    hint.replaceChildren(digits.length < 3 ? '' : network ? netTag(network) : 'Not an MTN, Telecel or AirtelTigo number');
  };
  phone.addEventListener('input', syncHint);
  syncHint();

  const save = h('button', { class: 'btn btn-primary', type: 'submit' }, contact ? 'Save' : 'Add contact');
  const dialog = h('dialog', { class: 'sheet', 'aria-labelledby': 'contact-dialog-title' });
  const close = () => dialog.close();

  // A modal sits above the toast layer, so errors are shown inside the sheet.
  const problem = h('div', { class: 'note bad', role: 'alert', hidden: true });
  const showProblem = err => {
    problem.textContent = err?.message || 'Something went wrong.';
    problem.hidden = false;
  };

  let armed = false;
  const remove = contact
    ? h('button', { class: 'btn btn-danger', type: 'button' }, 'Delete contact')
    : null;
  remove?.addEventListener('click', async () => {
    if (!armed) {
      armed = true;
      remove.textContent = `Tap again to delete ${contact.nickname}`;
      return;
    }
    try {
      await api('DELETE', `/api/contacts/${contact.id}`);
      close();
      toast(`Deleted ${contact.nickname}.`);
      onSaved();
    } catch (err) {
      showProblem(err);
    }
  });

  dialog.append(
    h('h2', { id: 'contact-dialog-title' }, contact ? 'Edit contact' : 'New contact'),
    h(
      'form',
      {
        onsubmit: event => {
          event.preventDefault();
          busy(save, async () => {
            try {
              const body = { nickname: name.value, phone: localDigits(phone.value) };
              if (contact) await api('PATCH', `/api/contacts/${contact.id}`, body);
              else await api('POST', '/api/contacts', body);
              close();
              toast(contact ? 'Contact saved.' : `Added ${name.value.trim()}.`);
              onSaved();
            } catch (err) {
              showProblem(err);
            }
          });
        },
      },
      h('div', { class: 'field' }, h('label', { for: 'contact-name' }, 'Name'), name),
      h('div', { class: 'field' }, h('label', { for: 'contact-phone' }, 'Mobile money number'), phone, hint),
      problem,
      save,
      contact
        ? h(
            'button',
            {
              class: 'btn btn-quiet',
              type: 'button',
              onclick: () => {
                close();
                go(`#/send?contact=${contact.id}`);
              },
            },
            `Send to ${contact.nickname}`
          )
        : null,
      h('button', { class: 'btn btn-quiet', type: 'button', onclick: close }, 'Cancel'),
      remove
    )
  );
  dialog.addEventListener('close', () => dialog.remove());
  // Tapping the dimmed area outside the sheet closes it.
  dialog.addEventListener('click', event => {
    if (event.target === dialog) close();
  });
  document.body.append(dialog);
  dialog.showModal();
  if (!contact) name.focus();
}

async function contactsScreen() {
  const alive = begin();
  const slot = h('div', {});

  const reload = async () => {
    try {
      await loadContacts();
      if (alive()) paint();
    } catch (err) {
      if (alive()) fail(err);
    }
  };

  const paint = () => {
    const list = state.contacts;
    slot.replaceChildren(
      !list
        ? h('div', { class: 'boot' }, h('span', { class: 'spinner muted' }))
        : list.length
          ? h(
              'div',
              { class: 'list' },
              list.map(c =>
                h(
                  'button',
                  { class: 'row', onclick: () => contactDialog(c, reload) },
                  avatar(c.nickname, c.network, 'sm'),
                  h(
                    'span',
                    { class: 'row-main' },
                    h('span', { class: 'row-title' }, c.nickname),
                    h('span', { class: 'row-sub' }, c.phone, ' · ', netTag(c.network, c.networkLabel))
                  ),
                  h('span', { class: 'chev' }, icon('chevron', 18))
                )
              )
            )
          : h('div', { class: 'empty' }, h('strong', {}, 'No contacts yet'), 'Save the people you send to most.')
    );
  };
  paint();

  teardown = () => document.querySelector('dialog.sheet')?.close();

  show(
    h(
      'main',
      { class: 'screen has-tabs' },
      topbar('Contacts', {
        action: h(
          'button',
          { class: 'icon-btn', 'aria-label': 'Add contact', onclick: () => contactDialog(null, reload) },
          icon('plus', 24)
        ),
      }),
      slot
    ),
    'contacts'
  );
  reload();
}

// --- Boot ------------------------------------------------------------------------------------

setUnauthorizedHandler(() => {
  if (!state.session?.authenticated) return;
  state.session = { ...state.session, authenticated: false };
  render();
});

async function boot() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
  try {
    state.session = await api('GET', '/api/session');
  } catch (err) {
    root.replaceChildren(
      h(
        'main',
        { class: 'gate' },
        h('img', { class: 'gate-logo', src: '/icons/icon.svg', alt: '' }),
        h('h1', {}, 'Easy-Send'),
        h('p', {}, err.message),
        h('button', { class: 'btn btn-primary', onclick: () => location.reload() }, 'Try again')
      )
    );
    return;
  }
  window.addEventListener('hashchange', render);
  render();
}

boot();
