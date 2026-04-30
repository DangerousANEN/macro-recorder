/**
 * Captcha Solver Module — unified interface for 2captcha and AntiCaptcha
 * AC7-AC10: Captcha solving service integration
 */

import { loadSettings } from './settings.js';

// ==================== 2captcha (AC8) ====================
const twoCaptchaImpl = {
  async solveCaptcha({ type, siteKey, pageUrl, apiKey, minScore }) {
    const baseUrl = 'https://2captcha.com';
    
    // Create task
    let taskPayload;
    if (type === 'recaptcha-v2') {
      taskPayload = {
        clientKey: apiKey,
        task: {
          type: 'RecaptchaV2TaskProxyless',
          websiteURL: pageUrl,
          websiteKey: siteKey,
        }
      };
    } else if (type === 'recaptcha-v3') {
      taskPayload = {
        clientKey: apiKey,
        task: {
          type: 'RecaptchaV3TaskProxyless',
          websiteURL: pageUrl,
          websiteKey: siteKey,
          minScore: minScore || 0.3,
        }
      };
    } else if (type === 'hcaptcha') {
      taskPayload = {
        clientKey: apiKey,
        task: {
          type: 'HCaptchaTaskProxyless',
          websiteURL: pageUrl,
          websiteKey: siteKey,
        }
      };
    } else {
      throw new Error(`Неподдерживаемый тип капчи для 2captcha: ${type}`);
    }
    
    const createResp = await fetch(`${baseUrl}/createTask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(taskPayload),
    });
    const createData = await createResp.json();
    
    if (createData.errorId && createData.errorId !== 0) {
      throw new Error(`2captcha createTask error: ${createData.errorDescription || createData.errorCode}`);
    }
    
    const taskId = createData.taskId;
    if (!taskId) throw new Error('2captcha: не получен taskId');
    
    // Poll for result (max 180s)
    const deadline = Date.now() + 180000;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 5000));
      
      const resultResp = await fetch(`${baseUrl}/getTaskResult`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientKey: apiKey, taskId }),
      });
      const resultData = await resultResp.json();
      
      if (resultData.status === 'ready') {
        return { token: resultData.solution?.gRecaptchaResponse || resultData.solution?.token || '' };
      }
      
      if (resultData.errorId && resultData.errorId !== 0) {
        throw new Error(`2captcha result error: ${resultData.errorDescription || resultData.errorCode}`);
      }
    }
    
    throw new Error('2captcha: таймаут решения капчи (180с)');
  },
  
  async getBalance(apiKey) {
    const resp = await fetch('https://2captcha.com/getBalance', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientKey: apiKey }),
    });
    const data = await resp.json();
    return { balance: data.balance || 0, currency: 'USD' };
  }
};

// ==================== AntiCaptcha (AC9) ====================
const antiCaptchaImpl = {
  async solveCaptcha({ type, siteKey, pageUrl, apiKey, minScore }) {
    const baseUrl = 'https://api.anti-captcha.com';
    
    let taskPayload;
    if (type === 'recaptcha-v2') {
      taskPayload = {
        clientKey: apiKey,
        task: {
          type: 'RecaptchaV2TaskProxyless',
          websiteURL: pageUrl,
          websiteKey: siteKey,
        }
      };
    } else if (type === 'recaptcha-v3') {
      taskPayload = {
        clientKey: apiKey,
        task: {
          type: 'RecaptchaV3TaskProxyless',
          websiteURL: pageUrl,
          websiteKey: siteKey,
          minScore: minScore || 0.3,
        }
      };
    } else if (type === 'hcaptcha') {
      taskPayload = {
        clientKey: apiKey,
        task: {
          type: 'HCaptchaTaskProxyless',
          websiteURL: pageUrl,
          websiteKey: siteKey,
        }
      };
    } else {
      throw new Error(`Неподдерживаемый тип капчи для anticaptcha: ${type}`);
    }
    
    const createResp = await fetch(`${baseUrl}/createTask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(taskPayload),
    });
    const createData = await createResp.json();
    
    if (createData.errorId && createData.errorId !== 0) {
      throw new Error(`AntiCaptcha error: ${createData.errorDescription || createData.errorCode}`);
    }
    
    const taskId = createData.taskId;
    if (!taskId) throw new Error('AntiCaptcha: не получен taskId');
    
    const deadline = Date.now() + 180000;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 5000));
      
      const resultResp = await fetch(`${baseUrl}/getTaskResult`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientKey: apiKey, taskId }),
      });
      const resultData = await resultResp.json();
      
      if (resultData.status === 'ready') {
        return { token: resultData.solution?.gRecaptchaResponse || resultData.solution?.token || '' };
      }
      
      if (resultData.errorId && resultData.errorId !== 0) {
        throw new Error(`AntiCaptcha result error: ${resultData.errorDescription || resultData.errorCode}`);
      }
    }
    
    throw new Error('AntiCaptcha: таймаут решения капчи (180с)');
  },
  
  async getBalance(apiKey) {
    const resp = await fetch('https://api.anti-captcha.com/getBalance', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientKey: apiKey }),
    });
    const data = await resp.json();
    return { balance: data.balance || 0, currency: 'USD' };
  }
};

// ==================== Unified interface (AC7) ====================

/**
 * Solve captcha using configured service with automatic failover (AC9)
 * @param {object} params - { type, siteKey, pageUrl, service?, minScore? }
 * @returns {Promise<{token: string}>}
 */
export async function solveCaptcha({ type, siteKey, pageUrl, service, minScore }) {
  const settings = loadSettings();
  const captchaSettings = settings.captchaServices || {};
  
  // Determine primary and fallback services
  let primaryService = service || captchaSettings.active || '2captcha';
  let fallbackService = primaryService === '2captcha' ? 'anticaptcha' : '2captcha';
  
  const impls = { '2captcha': twoCaptchaImpl, 'anticaptcha': antiCaptchaImpl };
  
  // Try primary
  const primaryApiKey = captchaSettings.services?.[primaryService]?.apiKey;
  if (primaryApiKey) {
    try {
      return await impls[primaryService].solveCaptcha({ type, siteKey, pageUrl, apiKey: primaryApiKey, minScore });
    } catch (e) {
      console.error(`Captcha primary (${primaryService}) failed:`, e.message);
      // Fall through to fallback
    }
  }
  
  // Try fallback (AC9: automatic failover)
  const fallbackApiKey = captchaSettings.services?.[fallbackService]?.apiKey;
  if (fallbackApiKey) {
    try {
      return await impls[fallbackService].solveCaptcha({ type, siteKey, pageUrl, apiKey: fallbackApiKey, minScore });
    } catch (e) {
      throw new Error(`Оба сервиса капчи не смогли решить: ${e.message}`);
    }
  }
  
  throw new Error(`Не настроен ни один сервис решения капчи`);
}

/**
 * Auto-detect captcha type on page (AC10)
 * @param {object} page - Playwright page
 * @returns {Promise<{type: string, siteKey: string}|null>}
 */
export async function autoDetectCaptcha(page) {
  return page.evaluate(() => {
    // Check for reCAPTCHA v2
    const recaptchaDiv = document.querySelector('div.g-recaptcha');
    if (recaptchaDiv) {
      return { type: 'recaptcha-v2', siteKey: recaptchaDiv.getAttribute('data-sitekey') || '' };
    }
    
    // Check for reCAPTCHA iframe
    const recaptchaIframe = document.querySelector('iframe[src*="recaptcha"]');
    if (recaptchaIframe) {
      const src = recaptchaIframe.src;
      const match = src.match(/[?&]k=([^&]+)/);
      return { type: 'recaptcha-v2', siteKey: match ? match[1] : '' };
    }
    
    // Check for hCaptcha
    const hcaptchaDiv = document.querySelector('div.h-captcha');
    if (hcaptchaDiv) {
      return { type: 'hcaptcha', siteKey: hcaptchaDiv.getAttribute('data-sitekey') || '' };
    }
    
    const hcaptchaIframe = document.querySelector('iframe[src*="hcaptcha"]');
    if (hcaptchaIframe) {
      const src = hcaptchaIframe.src;
      const match = src.match(/[?&]sitekey=([^&]+)/);
      return { type: 'hcaptcha', siteKey: match ? match[1] : '' };
    }
    
    return null;
  });
}

/**
 * Get captcha service balance
 * @param {string} service - '2captcha' or 'anticaptcha'
 * @returns {Promise<{balance: number, currency: string}>}
 */
export async function getCaptchaBalance(service) {
  const settings = loadSettings();
  const captchaSettings = settings.captchaServices || {};
  const apiKey = captchaSettings.services?.[service]?.apiKey;
  
  if (!apiKey) throw new Error(`Капча-сервис "${service}" не настроен (нет API ключа)`);
  
  const impls = { '2captcha': twoCaptchaImpl, 'anticaptcha': antiCaptchaImpl };
  const impl = impls[service];
  if (!impl) throw new Error(`Неизвестный капча-сервис: ${service}`);
  
  return impl.getBalance(apiKey);
}
