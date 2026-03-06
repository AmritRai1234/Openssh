// Typed client for the OpenSSH Relay API
import AsyncStorage from '@react-native-async-storage/async-storage';

export interface HostInfo {
  id: string;
  connected_at: number; // unix seconds
  relay_addr: string;
}

export interface PairInfo {
  id: string;
  pairing_string: string;
  qr_png_base64: string;
}

async function getConfig(): Promise<{ url: string; token: string }> {
  const url = (await AsyncStorage.getItem('relay_url')) ?? '';
  const token = (await AsyncStorage.getItem('api_token')) ?? '';
  return { url, token };
}

async function apiFetch(path: string, init?: RequestInit) {
  const { url, token } = await getConfig();
  if (!url || !token) throw new Error('Not configured');
  return fetch(`${url}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...init?.headers },
  });
}

export async function fetchStatus(): Promise<{ status: string; connected_hosts: number }> {
  const r = await apiFetch('/api/status');
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

export async function fetchHosts(): Promise<HostInfo[]> {
  const r = await apiFetch('/api/hosts');
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const data = await r.json();
  return data.hosts ?? [];
}

export async function fetchPair(id: string): Promise<PairInfo> {
  const r = await apiFetch(`/api/host/${id}/pair`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

export function createEventSocket(url: string, token: string, onEvent: (ev: object) => void): WebSocket {
  // Convert http(s) -> ws(s) and pass token as query param (React Native WS can't set headers)
  const wsUrl = url.replace(/^http/, 'ws') + `/api/events?token=${encodeURIComponent(token)}`;
  const ws = new WebSocket(wsUrl);
  ws.onmessage = (e) => {
    try { onEvent(JSON.parse(e.data)); } catch { }
  };
  return ws;
}

