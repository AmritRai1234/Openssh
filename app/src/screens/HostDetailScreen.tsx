import React, { useState, useEffect } from 'react';
import {
    View, Text, Image, TouchableOpacity, StyleSheet,
    ScrollView, ActivityIndicator, Alert, Share,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { HostInfo, fetchPair, PairInfo } from '../api/relay';

interface Props {
    host: HostInfo;
    onBack: () => void;
    onTerminal: (host: HostInfo) => void;
}

export default function HostDetailScreen({ host, onBack, onTerminal }: Props) {
    const [pair, setPair] = useState<PairInfo | null>(null);
    const [loading, setLoading] = useState(true);
    const [copied, setCopied] = useState(false);

    useEffect(() => {
        fetchPair(host.id)
            .then(setPair)
            .catch(e => Alert.alert('Error', e.message))
            .finally(() => setLoading(false));
    }, [host.id]);

    const copy = async () => {
        if (!pair) return;
        await Clipboard.setStringAsync(pair.pairing_string);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    const share = async () => {
        if (!pair) return;
        await Share.share({ message: pair.pairing_string });
    };

    return (
        <View style={styles.root}>
            {/* Header */}
            <View style={styles.header}>
                <TouchableOpacity onPress={onBack} style={styles.back}>
                    <Ionicons name="chevron-back" size={28} color="#5865F2" />
                </TouchableOpacity>
                <Text style={styles.title}>{host.id}</Text>
                <View style={{ width: 40 }} />
            </View>

            <ScrollView contentContainerStyle={styles.scroll}>
                {/* Status */}
                <View style={styles.statusCard}>
                    <View style={styles.onlineDot} />
                    <View>
                        <Text style={styles.statusLabel}>Online</Text>
                        <Text style={styles.statusSub}>{host.relay_addr}</Text>
                    </View>
                </View>

                {/* Actions */}
                <View style={styles.actions}>
                    <TouchableOpacity style={[styles.actionBtn, styles.terminalBtn]} onPress={() => onTerminal(host)}>
                        <Ionicons name="terminal-outline" size={24} color="#FFF" style={styles.actionIcon} />
                        <Text style={[styles.actionLabel, { color: '#FFF' }]}>Terminal</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={[styles.actionBtn, styles.secondaryBtn]} onPress={copy}>
                        <Ionicons name={copied ? 'checkmark-circle-outline' : 'copy-outline'} size={24} color={copied ? '#34C759' : '#1C1C1E'} style={styles.actionIcon} />
                        <Text style={styles.actionLabel}>{copied ? 'Copied!' : 'Copy'}</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={[styles.actionBtn, styles.secondaryBtn]} onPress={share}>
                        <Ionicons name="share-outline" size={24} color="#1C1C1E" style={styles.actionIcon} />
                        <Text style={styles.actionLabel}>Share</Text>
                    </TouchableOpacity>
                </View>

                {/* QR Code */}
                <Text style={styles.sectionTitle}>Scan to Pair Another Device</Text>
                <View style={styles.qrCard}>
                    {loading ? (
                        <ActivityIndicator color="#5865F2" size="large" />
                    ) : pair?.qr_png_base64 ? (
                        <Image
                            source={{ uri: `data:image/png;base64,${pair.qr_png_base64}` }}
                            style={styles.qrImage}
                            resizeMode="contain"
                        />
                    ) : (
                        <Text style={styles.noQr}>QR unavailable</Text>
                    )}
                </View>

                {/* Pairing string */}
                {pair && (
                    <View style={styles.pairStringCard}>
                        <Text style={styles.pairStringLabel}>Pairing String</Text>
                        <Text style={styles.pairString} numberOfLines={3} selectable>{pair.pairing_string}</Text>
                    </View>
                )}

                {/* Instructions */}
                <View style={styles.instructionCard}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                        <Ionicons name="link-outline" size={18} color="#5865F2" />
                        <Text style={styles.instrTitle}>How to connect</Text>
                    </View>
                    <Text style={styles.instrStep}>1. Copy the pairing string above</Text>
                    <Text style={styles.instrStep}>2. On the client machine, run:</Text>
                    <Text style={styles.instrCode}>./client --pair {"\"<string>\""} shell</Text>
                    <Text style={styles.instrStep}>3. Or scan the QR on a second phone</Text>
                </View>
            </ScrollView>
        </View>
    );
}

const styles = StyleSheet.create({
    root: { flex: 1, backgroundColor: '#F2F2F7' },
    header: {
        flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
        paddingTop: 56, paddingHorizontal: 16, paddingBottom: 16,
        backgroundColor: '#FFFFFF', borderBottomWidth: 1, borderColor: '#E5E5EA',
    },
    back: { padding: 8 },
    title: { color: '#1C1C1E', fontSize: 18, fontWeight: '700' },
    scroll: { padding: 16, paddingBottom: 40 },
    statusCard: {
        backgroundColor: '#FFFFFF', borderRadius: 18, padding: 16,
        flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 16,
        shadowColor: '#000', shadowOpacity: 0.06, shadowRadius: 8, shadowOffset: { width: 0, height: 2 }, elevation: 2,
    },
    onlineDot: { width: 12, height: 12, borderRadius: 6, backgroundColor: '#34C759' },
    statusLabel: { color: '#34C759', fontWeight: '700', fontSize: 15 },
    statusSub: { color: '#8E8E93', fontSize: 13 },
    actions: { flexDirection: 'row', gap: 10, marginBottom: 24 },
    actionBtn: {
        flex: 1, borderRadius: 16, padding: 14, alignItems: 'center',
        shadowColor: '#000', shadowOpacity: 0.05, shadowRadius: 6, shadowOffset: { width: 0, height: 2 }, elevation: 1,
    },
    terminalBtn: { backgroundColor: '#5865F2' },
    secondaryBtn: { backgroundColor: '#FFFFFF' },
    actionIcon: { marginBottom: 4 },
    actionLabel: { color: '#1C1C1E', fontSize: 11, fontWeight: '600' },
    sectionTitle: { color: '#8E8E93', fontSize: 13, fontWeight: '600', marginBottom: 12, letterSpacing: 0.5, textTransform: 'uppercase' },
    qrCard: {
        backgroundColor: '#FFFFFF', borderRadius: 20, padding: 20,
        alignItems: 'center', justifyContent: 'center', marginBottom: 16, minHeight: 220,
        shadowColor: '#000', shadowOpacity: 0.06, shadowRadius: 8, shadowOffset: { width: 0, height: 2 }, elevation: 2,
    },
    qrImage: { width: 200, height: 200 },
    noQr: { color: '#8E8E93' },
    pairStringCard: {
        backgroundColor: '#FFFFFF', borderRadius: 16, padding: 14, marginBottom: 16,
        shadowColor: '#000', shadowOpacity: 0.05, shadowRadius: 6, shadowOffset: { width: 0, height: 2 }, elevation: 1,
    },
    pairStringLabel: { color: '#8E8E93', fontSize: 11, fontWeight: '600', marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.5 },
    pairString: { color: '#5865F2', fontSize: 12, fontFamily: 'monospace' },
    instructionCard: {
        backgroundColor: '#FFFFFF', borderRadius: 16, padding: 16,
        shadowColor: '#000', shadowOpacity: 0.05, shadowRadius: 6, shadowOffset: { width: 0, height: 2 }, elevation: 1,
    },
    instrTitle: { color: '#1C1C1E', fontWeight: '700', fontSize: 15 },
    instrStep: { color: '#8E8E93', fontSize: 13, marginBottom: 6, lineHeight: 20 },
    instrCode: {
        backgroundColor: '#F2F2F7', color: '#5865F2', fontFamily: 'monospace',
        fontSize: 12, padding: 10, borderRadius: 10, marginVertical: 6,
    },
});
