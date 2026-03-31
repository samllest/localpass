function tryCaptureLogin() {
  const passwordInputs = document.querySelectorAll('input[type="password"]');
  let targetPasswordInput = null;

  for (let i = 0; i < passwordInputs.length; i++) {
    if (passwordInputs[i].value) {
      targetPasswordInput = passwordInputs[i];
      break;
    }
  }

  if (targetPasswordInput && targetPasswordInput.value) {
    const password = targetPasswordInput.value;
    
    const allInputs = Array.from(document.querySelectorAll('input:not([type="hidden"])'));
    const pwdIndex = allInputs.indexOf(targetPasswordInput);
    let username = '';
    
    for (let i = pwdIndex - 1; i >= 0; i--) {
      // type attribute might be empty string for generic text inputs
      if (['text', 'email', 'tel', ''].includes(allInputs[i].type)) {
        username = allInputs[i].value;
        if (username) break;
      }
    }

    if (!username) {
        const textInputs = document.querySelectorAll('input[type="text"], input[type="email"]');
        if (textInputs.length > 0) username = textInputs[0].value;
    }

    chrome.runtime.sendMessage({
      type: 'LP_LOGIN_SUBMITTED',
      payload: {
        identity: window.location.hostname,
        display_name: document.title || window.location.hostname,
        username,
        password
      }
    });

    console.log('[LocalPass] Captured login for', window.location.hostname);
  }
}

// 1. 标准 form 提交监听
document.addEventListener('submit', () => {
  tryCaptureLogin();
}, true);

// 2. 现代 SPA 点击登录按钮监听
document.addEventListener('click', (e) => {
  const el = e.target;
  // 初步匹配疑似登录按钮的元素
  const isButton = el.closest('button, input[type="button"], input[type="submit"], [class*="login"], [class*="submit"], [class*="btn"]');
  if (isButton) {
    tryCaptureLogin();
  }
}, true);

// 3. 回车键监听
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    tryCaptureLogin();
  }
}, true);
