import React, { useCallback } from 'react';
import {
    View, Text, FlatList, TouchableOpacity, StyleSheet,
    RefreshControl, StatusBar, Linking,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRelaySocket } from '../hooks/useRelaySocket';
import { HostInfo } from '../api/relay';

interface Props {
    onSelectHost: (host: HostInfo) => void;
    onSetup: () => void;
}

// 👇 Change this to your Ko-fi / PayPal / GitHub Sponsors link
const GIFT_URL = 'https://ko-fi.com';

export default function DashboardScreen({ onSelectHost, onSetup }: Props) {
    const { hosts, connected, error, refresh } = useRelaySocket();

    const renderHost = useCallback(({ item }: { item: HostInfo }) => (
        <TouchableOpacity style={styles.hostCard} onPress={() => onSelectHost(item)} activeOpacity={0.75}>
            <View style={styles.hostLeft}>
                <View style={[styles.onlineDot, !connected && { backgroundColor: '#C7C7CC' }]} />
                <View>
                    <Text style={styles.hostId}>{item.id}</Text>
                    <Text style={styles.hostSub}>
                        {connected
                            ? `${item.relay_addr} · connected ${formatAge(item.connected_at)}`
                            : 'Last seen · tap to reconnect'}
                    </Text>
                </View>
            </View>
            <Text style={styles.chevron}>›</Text>
        </TouchableOpacity>
    ), [onSelectHost, connected]);

    return (
        <View style={styles.root}>
            <StatusBar barStyle="dark-content" />

            {/* Header */}
            <View style={styles.header}>
                <View>
                    <Text style={styles.title}>OpenSSH</Text>
                    <View style={styles.relayStatus}>
                        <View style={[styles.dot, { backgroundColor: connected ? '#34C759' : '#FF9500' }]} />
                        <Text style={styles.relayLabel}>{connected ? 'Live' : 'Reconnecting...'}</Text>
                    </View>
                </View>
                <View style={styles.headerRight}>
                    <TouchableOpacity onPress={() => Linking.openURL(GIFT_URL)} style={styles.giftBtn}>
                        <Ionicons name="gift-outline" size={22} color="#FF6B6B" />
                    </TouchableOpacity>
                    <TouchableOpacity onPress={onSetup} style={styles.settingsBtn}>
                        <Ionicons name="settings-outline" size={24} color="#8E8E93" />
                    </TouchableOpacity>
                </View>
            </View>

            {/* Section row */}
            <View style={styles.section}>
                <Text style={styles.sectionTitle}>Connected Machines</Text>
                <Text style={styles.sectionCount}>{hosts.length} online</Text>
            </View>

            {/* Error */}
            {error && (
                <View style={styles.errorBanner}>
                    <Text style={styles.errorText}>⚠️ {error}</Text>
                </View>
            )}

            {/* Host list */}
            <FlatList
                data={hosts}
                keyExtractor={h => h.id}
                renderItem={renderHost}
                refreshControl={<RefreshControl refreshing={false} onRefresh={refresh} tintColor="#5865F2" />}
                contentContainerStyle={hosts.length === 0 ? styles.emptyContainer : styles.list}
                ListEmptyComponent={
                    <View style={styles.empty}>
                        <Ionicons name="desktop-outline" size={64} color="#C7C7CC" style={{ marginBottom: 16 }} />
                        <Text style={styles.emptyTitle}>No machines online</Text>
                        <Text style={styles.emptyHint}>Start the host daemon on your machine and it'll appear here</Text>
                    </View>
                }
            />
        </View>
    );
}

function formatAge(unix: number): string {
    const diff = Math.floor(Date.now() / 1000 - unix);
    if (diff < 60) return 'just now';
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    return `${Math.floor(diff / 3600)}h ago`;
}

const styles = StyleSheet.create({
    root: { flex: 1, backgroundColor: '#F2F2F7' },
    header: {
        flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start',
        paddingTop: 60, paddingHorizontal: 20, paddingBottom: 16,
        backgroundColor: '#FFFFFF', borderBottomWidth: 1, borderColor: '#E5E5EA',
    },
    title: { fontSize: 28, fontWeight: '800', color: '#1C1C1E' },
    relayStatus: { flexDirection: 'row', alignItems: 'center', marginTop: 4 },
    dot: { width: 8, height: 8, borderRadius: 4, marginRight: 6 },
    relayLabel: { color: '#8E8E93', fontSize: 13 },
    headerRight: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 4 },
    giftBtn: { padding: 8 },
    settingsBtn: { padding: 8 },
    section: {
        flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
        paddingHorizontal: 20, paddingVertical: 14,
    },
    sectionTitle: { color: '#8E8E93', fontSize: 13, fontWeight: '600', letterSpacing: 0.5, textTransform: 'uppercase' },
    sectionCount: { color: '#34C759', fontSize: 13, fontWeight: '700' },
    list: { paddingHorizontal: 16, paddingBottom: 24 },
    hostCard: {
        backgroundColor: '#FFFFFF', borderRadius: 18, padding: 16, marginBottom: 10,
        flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
        shadowColor: '#000', shadowOpacity: 0.06, shadowRadius: 8, shadowOffset: { width: 0, height: 2 },
        elevation: 2,
    },
    hostLeft: { flexDirection: 'row', alignItems: 'center', gap: 14 },
    onlineDot: { width: 11, height: 11, borderRadius: 6, backgroundColor: '#34C759' },
    hostId: { color: '#1C1C1E', fontSize: 16, fontWeight: '700' },
    hostSub: { color: '#8E8E93', fontSize: 12, marginTop: 2 },
    chevron: { color: '#C7C7CC', fontSize: 22 },
    emptyContainer: { flex: 1 },
    empty: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingTop: 80 },
    emptyTitle: { color: '#1C1C1E', fontSize: 20, fontWeight: '700', marginBottom: 8 },
    emptyHint: { color: '#8E8E93', fontSize: 14, textAlign: 'center', paddingHorizontal: 40, lineHeight: 22 },
    errorBanner: { backgroundColor: '#FFF2F0', marginHorizontal: 16, borderRadius: 12, padding: 12, marginBottom: 4, borderWidth: 1, borderColor: '#FFD5D0' },
    errorText: { color: '#FF3B30', fontSize: 14 },
});
