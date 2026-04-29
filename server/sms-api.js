/**
 * SMS API Module — unified interface for SMS-Activate, 5sim, SMSHub
 * AC1-AC6: SMS service integration
 */

import { loadSettings } from './settings.js';

// ==================== SMS-Activate (AC2) ====================
const smsActivateImpl = {
  async getNumber(apiKey, baseUrl, country = 'ru') {
    // Map country codes to sms-activate format
    const countryMap = { ru: '0', ua: '1', kz: '2', us: '12', gb: '16', de: '43', fr: '78' };
    const countryId = countryMap[country] || '0';
    
    const url = `${baseUrl}?api_key=${apiKey}&action=getNumber&service=tg&country=${countryId}`;
    const resp = await fetch(url);
    const text = await resp.text();
    
    if (text.startsWith('ACCESS_NUMBER')) {
      // Format: ACCESS_NUMBER:id:phone
      const parts = text.split(':');
      return { id: parts[1], phone: parts[2] };
    }
    
    throw new Error(`SMS-Activate getNumber error: ${text}`);
  },
  
  async checkCode(apiKey, baseUrl, id) {
    const url = `${baseUrl}?api_key=${apiKey}&action=getStatus&id=${id}`;
    const resp = await fetch(url);
    const text = await resp.text();
    
    if (text.startsWith('STATUS_OK')) {
      // Format: STATUS_OK:code
      return { code: text.split(':')[1], status: 'received' };
    }
    if (text === 'STATUS_WAIT_CODE') {
      return { code: null, status: 'waiting' };
    }
    if (text === 'STATUS_CANCEL') {
      return { code: null, status: 'cancelled' };
    }
    
    return { code: null, status: text };
  },
  
  async releaseNumber(apiKey, baseUrl, id) {
    const url = `${baseUrl}?api_key=${apiKey}&action=setStatus&status=8&id=${id}`;
    const resp = await fetch(url);
    const text = await resp.text();
    return { ok: text.includes('ACCESS') || text === 'STATUS_CANCEL' };
  },
  
  async getBalance(apiKey, baseUrl) {
    const url = `${baseUrl}?api_key=${apiKey}&action=getBalance`;
    const resp = await fetch(url);
    const text = await resp.text();
    
    if (text.startsWith('ACCESS_BALANCE')) {
      return { balance: parseFloat(text.split(':')[1]), currency: 'RUB' };
    }
    throw new Error(`SMS-Activate balance error: ${text}`);
  }
};

// ==================== 5sim (AC3) ====================
const fiveSimImpl = {
  async getNumber(apiKey, baseUrl, country = 'russia') {
    const countryMap = { ru: 'russia', ua: 'ukraine', kz: 'kazakhstan', us: 'usa', gb: 'england', de: 'germany', fr: 'france' };
    const countryName = countryMap[country] || country;
    
    const url = `${baseUrl}/user/buy/activation/${countryName}/any/telegram`;
    const resp = await fetch(url, {
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Accept': 'application/json' }
    });
    
    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`5sim getNumber error (${resp.status}): ${errText}`);
    }
    
    const data = await resp.json();
    return { id: String(data.id), phone: data.phone };
  },
  
  async checkCode(apiKey, baseUrl, id) {
    const url = `${baseUrl}/user/check/${id}`;
    const resp = await fetch(url, {
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Accept': 'application/json' }
    });
    
    if (!resp.ok) {
      return { code: null, status: 'error' };
    }
    
    const data = await resp.json();
    if (data.sms && data.sms.length > 0) {
      const lastSms = data.sms[data.sms.length - 1];
      return { code: lastSms.code, status: 'received' };
    }
    
    return { code: null, status: data.status || 'waiting' };
  },
  
  async releaseNumber(apiKey, baseUrl, id) {
    const url = `${baseUrl}/user/cancel/${id}`;
    const resp = await fetch(url, {
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Accept': 'application/json' }
    });
    return { ok: resp.ok };
  },
  
  async getBalance(apiKey, baseUrl) {
    const url = `${baseUrl}/user/profile`;
    const resp = await fetch(url, {
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Accept': 'application/json' }
    });
    
    if (!resp.ok) throw new Error(`5sim balance error: ${resp.status}`);
    
    const data = await resp.json();
    return { balance: data.balance || 0, currency: 'RUB' };
  }
};

// ==================== SMSHub (AC4) ====================
// Same protocol as SMS-Activate (compatible stubs)
const smsHubImpl = {
  async getNumber(apiKey, baseUrl, country = 'ru') {
    const countryMap = { ru: '0', ua: '1', kz: '2', us: '12', gb: '16', de: '43', fr: '78' };
    const countryId = countryMap[country] || '0';
    
    const url = `${baseUrl}?api_key=${apiKey}&action=getNumber&service=tg&country=${countryId}`;
    const resp = await fetch(url);
    const text = await resp.text();
    
    if (text.startsWith('ACCESS_NUMBER')) {
      const parts = text.split(':');
      return { id: parts[1], phone: parts[2] };
    }
    throw new Error(`SMSHub getNumber error: ${text}`);
  },
  
  async checkCode(apiKey, baseUrl, id) {
    return smsActivateImpl.checkCode(apiKey, baseUrl, id);
  },
  
  async releaseNumber(apiKey, baseUrl, id) {
    return smsActivateImpl.releaseNumber(apiKey, baseUrl, id);
  },
  
  async getBalance(apiKey, baseUrl) {
    const url = `${baseUrl}?api_key=${apiKey}&action=getBalance`;
    const resp = await fetch(url);
    const text = await resp.text();
    
    if (text.startsWith('ACCESS_BALANCE')) {
      return { balance: parseFloat(text.split(':')[1]), currency: 'RUB' };
    }
    throw new Error(`SMSHub balance error: ${text}`);
  }
};

// ==================== Service registry ====================
const implementations = {
  'sms-activate': smsActivateImpl,
  '5sim': fiveSimImpl,
  'smshub': smsHubImpl,
};

function getServiceConfig(serviceName) {
  const settings = loadSettings();
  const smsSettings = settings.smsServices || {};
  const svc = smsSettings.services?.[serviceName];
  if (!svc || !svc.apiKey) {
    throw new Error(`SMS сервис "${serviceName}" не настроен (нет API ключа)`);
  }
  return svc;
}

function getImpl(serviceName) {
  const impl = implementations[serviceName];
  if (!impl) throw new Error(`Неизвестный SMS сервис: ${serviceName}. Доступны: ${Object.keys(implementations).join(', ')}`);
  return impl;
}

// ==================== Unified interface (AC1) ====================

/**
 * Get a phone number from SMS service
 * @param {string} service - Service name (sms-activate, 5sim, smshub)
 * @param {string} [country='ru'] - Country code
 * @returns {Promise<{id: string, phone: string}>}
 */
export async function getNumber(service, country = 'ru') {
  const impl = getImpl(service);
  const config = getServiceConfig(service);
  return impl.getNumber(config.apiKey, config.baseUrl, country);
}

/**
 * Check for received SMS code
 * @param {string} service
 * @param {string} id - SMS activation ID
 * @returns {Promise<{code: string|null, status: string}>}
 */
export async function checkCode(service, id) {
  const impl = getImpl(service);
  const config = getServiceConfig(service);
  return impl.checkCode(config.apiKey, config.baseUrl, id);
}

/**
 * Release/cancel a number
 * @param {string} service
 * @param {string} id
 * @returns {Promise<{ok: boolean}>}
 */
export async function releaseNumber(service, id) {
  const impl = getImpl(service);
  const config = getServiceConfig(service);
  return impl.releaseNumber(config.apiKey, config.baseUrl, id);
}

/**
 * Get account balance
 * @param {string} service
 * @returns {Promise<{balance: number, currency: string}>}
 */
export async function getBalance(service) {
  const impl = getImpl(service);
  const config = getServiceConfig(service);
  return impl.getBalance(config.apiKey, config.baseUrl);
}

/**
 * Poll for SMS code with retry logic (AC5)
 * @param {string} service
 * @param {string} id
 * @param {number} [timeoutSec=120] - Max wait time
 * @param {number} [intervalMs=5000] - Poll interval
 * @param {function} [onPoll] - Callback on each poll
 * @returns {Promise<{code: string}>}
 */
export async function waitForCode(service, id, timeoutSec = 120, intervalMs = 5000, onPoll = null) {
  const deadline = Date.now() + timeoutSec * 1000;
  
  while (Date.now() < deadline) {
    const result = await checkCode(service, id);
    
    if (onPoll) onPoll(result);
    
    if (result.code) {
      return { code: result.code };
    }
    
    if (result.status === 'cancelled' || result.status === 'error') {
      throw new Error(`SMS код отменён или ошибка: ${result.status}`);
    }
    
    // Wait before next poll
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  
  // Timeout — auto-release number (AC5)
  try {
    await releaseNumber(service, id);
  } catch (e) {
    // Ignore release errors on timeout
  }
  
  throw new Error(`Таймаут ожидания SMS кода (${timeoutSec}с)`);
}
