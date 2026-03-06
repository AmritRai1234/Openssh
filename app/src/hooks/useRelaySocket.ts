import { useState, useEffect, useRef, useCallback } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { HostInfo, fetchHosts, createEventSocket } from '../api/relay';

interface RelayEvent { event: 'connected' | 'disconnected'; id: string; }

export function useRelaySocket() {
    const [hosts, setHosts] = useState<HostInfo[]>([]);
    const [connected, setConnected] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const wsRef = useRef<WebSocket | null>(null);

    const load = useCallback(async () => {
        try {
            setError(null);
            const list = await fetchHosts();
            setHosts(list);
        } catch (e: any) {
            setError(e.message);
        }
    }, []);

    const connectWs = useCallback(async () => {
        const url = (await AsyncStorage.getItem('relay_url')) ?? '';
        const token = (await AsyncStorage.getItem('api_token')) ?? '';
        if (!url || !token) return;

        if (wsRef.current) wsRef.current.close();
        const ws = createEventSocket(url, token, (ev: any) => {
            const event = ev as RelayEvent;
            if (event.event === 'connected') {
                load(); // refresh list
            } else if (event.event === 'disconnected') {
                setHosts(prev => prev.filter(h => h.id !== event.id));
            }
        });
        ws.onopen = () => setConnected(true);
        ws.onclose = () => { setConnected(false); setTimeout(connectWs, 3000); }; // auto-reconnect
        ws.onerror = () => setError('WebSocket error');
        wsRef.current = ws;
    }, [load]);

    useEffect(() => {
        load();
        connectWs();
        return () => wsRef.current?.close();
    }, []);

    return { hosts, connected, error, refresh: load };
}
