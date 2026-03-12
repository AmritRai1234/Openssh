import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import {
    View, Text, TextInput, TouchableOpacity, StyleSheet,
    FlatList, Platform, StatusBar, LayoutAnimation, UIManager,
    Dimensions,
} from 'react-native';

// Enable LayoutAnimation on Android
if (Platform.OS === 'android') UIManager.setLayoutAnimationEnabledExperimental?.(true);
import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { HostInfo } from '../api/relay';

// ─────────────────────────────────────────────────────────
//  ANSI → React Native styled spans
// ─────────────────────────────────────────────────────────

const ANSI_COLORS: Record<number, string> = {
    // Standard foreground
    30: '#1C1C1E', 31: '#FF453A', 32: '#30D158', 33: '#FFD60A',
    34: '#0A84FF', 35: '#BF5AF2', 36: '#64D2FF', 37: '#E5E5EA',
    // Bright foreground
    90: '#636366', 91: '#FF6961', 92: '#4CD964', 93: '#FFE066',
    94: '#5AC8FA', 95: '#DA8FFF', 96: '#70D7FF', 97: '#F5F5F7',
    // Standard background
    40: '#1C1C1E', 41: '#FF453A', 42: '#30D158', 43: '#FFD60A',
    44: '#0A84FF', 45: '#BF5AF2', 46: '#64D2FF', 47: '#E5E5EA',
    // Bright background
    100: '#636366', 101: '#FF6961', 102: '#4CD964', 103: '#FFE066',
    104: '#5AC8FA', 105: '#DA8FFF', 106: '#70D7FF', 107: '#F5F5F7',
};

interface AnsiSpan {
    text: string;
    color?: string;
    bgColor?: string;
    bold?: boolean;
    underline?: boolean;
    dim?: boolean;
}

/**
 * Parse a string with ANSI SGR codes into styled spans.
 */
function parseAnsi(raw: string): AnsiSpan[] {
    const spans: AnsiSpan[] = [];
    // Match CSI sequences: ESC[...m  and also strip other ESC sequences
    const re = /\x1b\[([0-9;]*)m/g;
    let lastIndex = 0;
    let color: string | undefined;
    let bgColor: string | undefined;
    let bold = false;
    let underline = false;
    let dim = false;

    // Strip non-SGR escape sequences (cursor movement, title, etc.)
    const cleaned = raw
        .replace(/\x1b\[[0-9;?]*[A-HJKSTfhl]/g, '') // cursor/erase
        .replace(/\x1b\][^\x07]*\x07/g, '')           // OSC sequences  
        .replace(/\x1b[()][0-9A-Za-z]/g, '')           // charset
        .replace(/\r/g, '');

    let match: RegExpExecArray | null;
    while ((match = re.exec(cleaned)) !== null) {
        // Push text before this escape
        if (match.index > lastIndex) {
            const text = cleaned.slice(lastIndex, match.index);
            if (text) spans.push({ text, color, bgColor, bold, underline, dim });
        }
        // Parse SGR params
        const params = match[1] ? match[1].split(';').map(Number) : [0];
        for (let i = 0; i < params.length; i++) {
            const p = params[i];
            if (p === 0) { color = undefined; bgColor = undefined; bold = false; underline = false; dim = false; }
            else if (p === 1) bold = true;
            else if (p === 2) dim = true;
            else if (p === 4) underline = true;
            else if (p === 22) { bold = false; dim = false; }
            else if (p === 24) underline = false;
            else if (p >= 30 && p <= 37) color = ANSI_COLORS[p];
            else if (p === 39) color = undefined;
            else if (p >= 40 && p <= 47) bgColor = ANSI_COLORS[p];
            else if (p === 49) bgColor = undefined;
            else if (p >= 90 && p <= 97) color = ANSI_COLORS[p];
            else if (p >= 100 && p <= 107) bgColor = ANSI_COLORS[p];
            // 256-color: ESC[38;5;<n>m
            else if (p === 38 && params[i + 1] === 5) { i += 2; /* skip, use default */ }
            else if (p === 48 && params[i + 1] === 5) { i += 2; }
        }
        lastIndex = match.index + match[0].length;
    }
    // Remaining text
    const tail = cleaned.slice(lastIndex);
    if (tail) spans.push({ text: tail, color, bgColor, bold, underline, dim });
    return spans;
}

// ─────────────────────────────────────────────────────────
//  Resize helpers
// ─────────────────────────────────────────────────────────

const CHAR_WIDTH  = 8.4;  // approximate monospace char width at fontSize 13
const CHAR_HEIGHT = 20;   // lineHeight

function calcTermSize(width: number, height: number) {
    const cols = Math.max(20, Math.floor((width - 28) / CHAR_WIDTH));     // 28 = padding
    const rows = Math.max(5,  Math.floor((height - 120) / CHAR_HEIGHT));  // 120 = header+input
    return { cols, rows };
}

// ─────────────────────────────────────────────────────────
//  Component
// ─────────────────────────────────────────────────────────

interface Line { id: string; text: string; spans?: AnsiSpan[]; type: 'input' | 'output' | 'error' | 'info'; }

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
    const isNearTop = useRef(true);
    const lastSentSize = useRef<string>('');

    const addLine = useCallback((raw: string, type: Line['type'] = 'output') => {
        const spans = type === 'output' ? undefined : undefined; // parsed per-line below
        const parts = raw.split('\n').filter(l => l.length > 0);
        const newLines = parts.map(part => {
            const parsedSpans = type === 'output' ? parseAnsi(part) : undefined;
            // For non-output lines, use the raw text
            const text = type === 'output'
                ? parsedSpans?.map(s => s.text).join('') ?? part
                : part;
            return { id: String(lineId.current++), text, spans: parsedSpans, type };
        });
        if (newLines.length === 0) return;
        LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
        setLines(prev => [...prev, ...newLines]);
        if (isNearTop.current) {
            setTimeout(() => flatRef.current?.scrollToOffset({ offset: 0, animated: false }), 30);
        }
    }, []);

    // Send resize message to host via WebSocket
    const sendResize = useCallback(() => {
        const { width, height } = Dimensions.get('window');
        const { cols, rows } = calcTermSize(width, height);
        const key = `${cols}x${rows}`;
        if (key === lastSentSize.current) return; // don't spam
        lastSentSize.current = key;
        const ws = wsRef.current;
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ resize: [cols, rows] }));
        }
    }, []);

    const autoReconnect = useRef(true);

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
            ws.onopen = () => {
                setConnected(true);
                addLine('── Connected ──', 'info');
                // Send initial terminal size
                sendResize();
            };
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
                if (autoReconnect.current) {
                    addLine('Reconnecting in 3s...', 'info');
                    setTimeout(() => { if (autoReconnect.current) connect(); }, 3000);
                }
            };
        } catch (e: any) { addLine(`Error: ${e.message}`, 'error'); setDead(true); }
    }, [host.id, addLine, sendResize]);

    useEffect(() => {
        autoReconnect.current = true;
        connect();
        return () => { autoReconnect.current = false; wsRef.current?.close(); };
    }, []);

    // Listen for screen dimension changes (rotation, split-screen)
    useEffect(() => {
        const sub = Dimensions.addEventListener('change', () => sendResize());
        return () => sub?.remove();
    }, [sendResize]);

    const send = () => {
        const cmd = input.trim();
        if (!cmd || !connected) return;
        addLine(`$ ${cmd}`, 'input');
        setInput('');
        wsRef.current?.send(cmd + '\n');
    };

    const renderSpans = (spans: AnsiSpan[]) => {
        return spans.map((span, i) => (
            <Text
                key={i}
                style={[
                    styles.line,
                    { color: span.color ?? '#E5E5EA' },
                    span.bgColor ? { backgroundColor: span.bgColor } : undefined,
                    span.bold ? { fontWeight: '700' as const } : undefined,
                    span.underline ? { textDecorationLine: 'underline' as const } : undefined,
                    span.dim ? { opacity: 0.5 } : undefined,
                ]}
            >
                {span.text}
            </Text>
        ));
    };

    const renderLine = ({ item }: { item: Line }) => {
        // Render ANSI-styled output
        if (item.type === 'output' && item.spans && item.spans.length > 0) {
            return (
                <Text style={styles.line} selectable>
                    {renderSpans(item.spans)}
                </Text>
            );
        }
        // Plain text for input/error/info
        return (
            <Text style={[styles.line, styles[item.type === 'input' ? 'cmdLine' : item.type]]} selectable>{item.text}</Text>
        );
    };

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
