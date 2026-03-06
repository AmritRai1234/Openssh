import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
    View, Text, TextInput, TouchableOpacity, StyleSheet,
    FlatList, Platform, StatusBar, LayoutAnimation, UIManager,
} from 'react-native';

// Enable LayoutAnimation on Android
if (Platform.OS === 'android') UIManager.setLayoutAnimationEnabledExperimental?.(true);
import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { HostInfo } from '../api/relay';

// Strip ANSI escape codes (colors, bold, cursor movement, etc.) from raw PTY output
const ANSI_RE = /\x1b(\[[0-9;?]*[a-zA-Z]|\][^\x07]*\x07|[()][0-9A-Za-z]|[^\[\]()])/g;
function stripAnsi(str: string): string {
    return str.replace(ANSI_RE, '').replace(/\r/g, '');
}

interface Line { id: string; text: string; type: 'input' | 'output' | 'error' | 'info'; }

interface Props {
    host: HostInfo;
    onBack: () => void;
}

export default function TerminalScreen({ host, onBack }: Props) {
    const [lines, setLines] = useState<Line[]>([
        { id: '0', text: `Connecting to ${host.id}...`, type: 'info' },
    ]);
    const [input, setInput] = useState('');
    const [connected, setConnected] = useState(false);
    const [dead, setDead] = useState(false);
    const wsRef = useRef<WebSocket | null>(null);
    const flatRef = useRef<FlatList>(null);
    const lineId = useRef(1);
    const isNearTop = useRef(true); // true = user is at newest output (offset ~0)

    const addLine = useCallback((raw: string, type: Line['type'] = 'output') => {
        const text = type === 'output' ? stripAnsi(raw) : raw;
        const parts = text.split('\n').filter(l => l.length > 0);
        const newLines = parts.map(part => ({ id: String(lineId.current++), text: part, type }));
        if (newLines.length === 0) return;
        // Animate new rows sliding in — works correctly with inverted list
        LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
        setLines(prev => [...prev, ...newLines]);
        // Only snap to newest if user hasn't scrolled away to read history
        if (isNearTop.current) {
            setTimeout(() => flatRef.current?.scrollToOffset({ offset: 0, animated: false }), 30);
        }
    }, []);

    const autoReconnect = useRef(true); // false when user intentionally leaves

    const connect = useCallback(async () => {
        wsRef.current?.close();
        setDead(false);
        setConnected(false);
        addLine('Connecting...', 'info');
        try {
            const relayUrl = (await AsyncStorage.getItem('relay_url')) ?? '';
            const token = (await AsyncStorage.getItem('api_token')) ?? '';
            if (!relayUrl || !token) { addLine('Error: relay URL or token not configured.', 'error'); setDead(true); return; }
            const wsUrl = `${relayUrl.replace(/^http/, 'ws')}/api/terminal/${host.id}?token=${encodeURIComponent(token)}`;
            const ws = new WebSocket(wsUrl);
            wsRef.current = ws;
            ws.onopen = () => { setConnected(true); addLine('── Connected ──', 'info'); };
            ws.onmessage = (e) => {
                if (typeof e.data === 'string') addLine(e.data, 'output');
                else if (e.data instanceof ArrayBuffer) addLine(new TextDecoder().decode(e.data), 'output');
                else { const r = new FileReader(); r.onload = () => addLine(r.result as string, 'output'); r.readAsText(e.data); }
            };
            ws.onerror = () => addLine('Connection error — retrying...', 'info');
            ws.onclose = (e) => {
                setConnected(false);
                setDead(true);
                addLine(`── Disconnected${e.reason ? `: ${e.reason}` : ''} ──`, 'info');
                // Auto-reconnect after 3s unless user navigated away
                if (autoReconnect.current) {
                    addLine('Reconnecting in 3s...', 'info');
                    setTimeout(() => { if (autoReconnect.current) connect(); }, 3000);
                }
            };
        } catch (e: any) { addLine(`Error: ${e.message}`, 'error'); setDead(true); }
    }, [host.id, addLine]);

    useEffect(() => {
        autoReconnect.current = true;
        connect();
        return () => { autoReconnect.current = false; wsRef.current?.close(); };
    }, []);

    const send = () => {
        const cmd = input.trim();
        if (!cmd || !connected) return;
        addLine(`$ ${cmd}`, 'input');
        setInput('');
        wsRef.current?.send(cmd + '\n');
    };

    const renderLine = ({ item }: { item: Line }) => (
        <Text style={[styles.line, styles[item.type === 'input' ? 'cmdLine' : item.type]]} selectable>{item.text}</Text>
    );

    return (
        <View style={styles.root}>
            <StatusBar barStyle="dark-content" />

            {/* Header */}
            <View style={styles.header}>
                <TouchableOpacity onPress={onBack} style={styles.back}>
                    <Ionicons name="chevron-back" size={28} color="#5865F2" />
                </TouchableOpacity>
                <View style={styles.titleRow}>
                    <View style={[styles.dot, { backgroundColor: connected ? '#34C759' : dead ? '#FF3B30' : '#FF9500' }]} />
                    <Text style={styles.title}>{host.id}</Text>
                </View>
                {dead ? (
                    <TouchableOpacity onPress={connect} style={styles.reconnectBtn}>
                        <Ionicons name="refresh" size={16} color="#5865F2" />
                        <Text style={styles.reconnectText}> Retry</Text>
                    </TouchableOpacity>
                ) : (
                    <View style={{ width: 64 }} />
                )}
            </View>

            {/* Command bar at top */}
            <View style={[styles.inputRow, !connected && styles.inputRowDisabled]}>
                <Text style={styles.prompt}>$</Text>
                <TextInput
                    style={styles.textInput}
                    value={input}
                    onChangeText={setInput}
                    onSubmitEditing={send}
                    placeholder={connected ? 'enter command...' : 'not connected'}
                    placeholderTextColor="#555"
                    autoCapitalize="none"
                    autoCorrect={false}
                    returnKeyType="send"
                    blurOnSubmit={false}
                    editable={connected}
                />
                <TouchableOpacity style={[styles.sendBtn, !connected && styles.sendBtnDisabled]} onPress={send} disabled={!connected}>
                    <Ionicons name="return-down-back" size={18} color="#FFF" />
                </TouchableOpacity>
            </View>

            {/* Terminal output */}
            <View style={styles.terminalCard}>
                <FlatList
                    ref={flatRef}
                    data={lines}
                    keyExtractor={l => l.id}
                    renderItem={renderLine}
                    style={{ flex: 1 }}
                    contentContainerStyle={styles.terminalContent}
                    inverted
                    onScroll={e => {
                        // offset 0 = top of inverted list = newest output
                        isNearTop.current = e.nativeEvent.contentOffset.y < 80;
                    }}
                    scrollEventThrottle={100}
                />
            </View>
        </View>
    );
}

const styles = StyleSheet.create({
    root: { flex: 1, backgroundColor: '#F2F2F7' },
    header: {
        flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
        paddingTop: 56, paddingHorizontal: 16, paddingBottom: 14,
        backgroundColor: '#FFFFFF',
        borderBottomWidth: 1, borderColor: '#E5E5EA',
    },
    back: { padding: 8 },
    titleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    dot: { width: 9, height: 9, borderRadius: 5 },
    title: { color: '#1C1C1E', fontSize: 17, fontWeight: '700' },
    reconnectBtn: {
        flexDirection: 'row', alignItems: 'center',
        backgroundColor: '#F0F1FF', borderRadius: 10, paddingHorizontal: 12, paddingVertical: 6,
        borderWidth: 1, borderColor: '#5865F2',
    },
    reconnectText: { color: '#5865F2', fontSize: 13, fontWeight: '700' },

    // Command bar — matte black
    inputRow: {
        flexDirection: 'row', alignItems: 'center',
        backgroundColor: '#1C1C1E', marginHorizontal: 16, marginVertical: 12,
        borderRadius: 16, paddingHorizontal: 14, paddingVertical: 10,
        shadowColor: '#000', shadowOpacity: 0.15, shadowRadius: 8, shadowOffset: { width: 0, height: 2 },
        elevation: 3,
    },
    inputRowDisabled: { opacity: 0.45 },
    prompt: { color: '#5865F2', fontSize: 18, fontWeight: '800', marginRight: 8, fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace' },
    textInput: { color: '#F5F5F5', flex: 1, fontSize: 15, fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace' },
    sendBtn: { backgroundColor: '#5865F2', borderRadius: 10, padding: 8, marginLeft: 8, alignItems: 'center', justifyContent: 'center' },
    sendBtnDisabled: { backgroundColor: '#3A3A3C' },

    // Output area
    terminalCard: {
        flex: 1, backgroundColor: '#1C1C1E', marginHorizontal: 16, marginBottom: 16,
        borderRadius: 20, overflow: 'hidden',
        shadowColor: '#000', shadowOpacity: 0.12, shadowRadius: 12, shadowOffset: { width: 0, height: 4 },
        elevation: 4,
    },
    terminalContent: { padding: 14 },
    line: { fontSize: 13, fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace', lineHeight: 20, marginBottom: 2 },
    output: { color: '#E5E5EA' },
    cmdLine: { color: '#30D158' },
    error: { color: '#FF453A' },
    info: { color: '#636366' },
});
