(function () {
  'use strict';
  const { post, get } = window.DocFlow;
  const loginForm = document.getElementById('login-form');
  const registerForm = document.getElementById('register-form');

  // Where to go after signing in. Only same-site paths are allowed (prevents open redirects).
  const rawNext = new URLSearchParams(window.location.search).get('next') || '';
  const nextUrl = /^\/(?!\/)[^\s\\]*$/.test(rawNext) ? rawNext : '/dashboard';
  if (nextUrl.startsWith('/editor')) document.getElementById('next-hint').hidden = false;

  get('/api/auth/session')
    .then(({ user }) => { if (user) window.location.replace(nextUrl); })
    .catch(() => {});

  // Same rules as the server (src/validate.js).
  const EMAIL_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._%+-]*[A-Za-z0-9_%+-])?@(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\.)+[A-Za-z]{2,}$/;
  const isValidEmail = (v) => v.length <= 254 && EMAIL_RE.test(v) && !v.includes('..');
  const PW_RULES = {
    length: (v) => v.length >= 8 && v.length <= 128,
    letter: (v) => /[A-Za-z]/.test(v),
    number: (v) => /[0-9]/.test(v),
    special: (v) => /[^A-Za-z0-9\s]/.test(v),
    nospace: (v) => !/\s/.test(v),
  };

  function toggle(showRegister) {
    loginForm.hidden = showRegister;
    registerForm.hidden = !showRegister;
    document.getElementById('login-error').textContent = '';
    document.getElementById('register-error').textContent = '';
  }
  document.getElementById('show-register').addEventListener('click', (e) => { e.preventDefault(); toggle(true); });
  document.getElementById('show-login').addEventListener('click', (e) => { e.preventDefault(); toggle(false); });

  // Demo buttons only fill in the form; the user still presses "Sign in".
  document.querySelectorAll('.demo-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      toggle(false);
      loginForm.email.value = btn.dataset.email;
      loginForm.password.value = 'Password123!';
      document.querySelectorAll('.demo-btn').forEach((b) => b.classList.toggle('selected', b === btn));
      loginForm.querySelector('button[type=submit]').focus();
    });
  });

  // ---- Live validation on the sign-up form ----
  const emailHint = document.getElementById('email-hint');
  const confirmHint = document.getElementById('confirm-hint');

  function checkEmail(show) {
    const v = registerForm.email.value.trim();
    const ok = isValidEmail(v);
    emailHint.textContent = !ok && show && v ? 'Please enter a valid email address, like name@example.com.' : '';
    registerForm.email.setAttribute('aria-invalid', String(!ok && show && !!v));
    return ok;
  }
  function checkPassword() {
    const v = registerForm.password.value;
    let allOk = true;
    for (const [rule, test] of Object.entries(PW_RULES)) {
      const ok = test(v);
      allOk = allOk && ok;
      const li = document.querySelector(`#pw-rules [data-rule="${rule}"]`);
      li.classList.toggle('ok', ok);
      li.classList.toggle('bad', !ok && v.length > 0);
    }
    return allOk;
  }
  function checkConfirm(show) {
    const pw = registerForm.password.value;
    const confirm = registerForm.confirmPassword.value;
    const ok = confirm.length > 0 && confirm === pw;
    confirmHint.textContent = show && confirm && !ok ? 'Passwords do not match.' : ok ? 'Passwords match.' : '';
    confirmHint.className = `field-hint ${ok ? 'hint-ok' : ''}`;
    registerForm.confirmPassword.setAttribute('aria-invalid', String(show && !!confirm && !ok));
    return ok;
  }
  registerForm.email.addEventListener('blur', () => checkEmail(true));
  registerForm.email.addEventListener('input', () => { if (emailHint.textContent) checkEmail(true); });
  registerForm.password.addEventListener('input', () => { checkPassword(); if (registerForm.confirmPassword.value) checkConfirm(true); });
  registerForm.confirmPassword.addEventListener('input', () => checkConfirm(true));

  async function submit(form, errorEl, url, body) {
    const button = form.querySelector('button[type=submit]');
    button.disabled = true;
    try {
      await post(url, body);
      window.location.replace(nextUrl);
    } catch (err) {
      errorEl.textContent = err.message;
    } finally {
      button.disabled = false;
    }
  }

  loginForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const errorEl = document.getElementById('login-error');
    const email = loginForm.email.value.trim();
    const password = loginForm.password.value;
    if (!email || !password) { errorEl.textContent = 'Please enter your email and password.'; return; }
    if (!isValidEmail(email)) { errorEl.textContent = 'Please enter a valid email address.'; return; }
    errorEl.textContent = '';
    submit(loginForm, errorEl, '/api/auth/login', { email, password });
  });

  registerForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const errorEl = document.getElementById('register-error');
    const name = registerForm.name.value.trim();
    const email = registerForm.email.value.trim();
    const password = registerForm.password.value;
    const confirmPassword = registerForm.confirmPassword.value;
    let error = '';
    if (!name || !email || !password || !confirmPassword) error = 'Please fill in all fields.';
    else if (!checkEmail(true)) error = 'Please fix the email address above.';
    else if (!checkPassword()) error = 'Your password does not meet all the requirements listed above.';
    else if (!checkConfirm(true)) error = 'Please make sure both passwords match.';
    errorEl.textContent = error;
    if (error) return;
    submit(registerForm, errorEl, '/api/auth/register', { name, email, password, confirmPassword });
  });
})();
