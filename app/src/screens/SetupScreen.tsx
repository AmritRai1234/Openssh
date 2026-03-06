import React, { useState } from 'react';
import {
    View, Text, TextInput, TouchableOpacity, StyleSheet,
    KeyboardAvoidingView, Platform, ScrollView, ActivityIndicator, Alert,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { fetchStatus } from '../api/relay';

export default function SetupScreen({ onDone }: { onDone: () => void }) {
    const [relayUrl, setRelayUrl] = useState('');
    const [token, setToken] = useState('');
    const [testing, setTesting] = useState(false);
    const [scanning, setScanning] = useState(false);
    const [permission, requestPermission] = useCameraPermissions();

    const handleScan = async () => {
        if (!permission?.granted) {
            const { granted } = await requestPermission();
            if (!granted) { Alert.alert('Camera access denied', 'Allow camera to scan the relay QR code.'); return; }
        }
        setScanning(true);
    };

    const onBarcodeScanned = ({ data }: { data: string }) => {
        try {
            const params = new URLSearchParams(data.replace('russh-api://', ''));
            const url = params.get('url');
            const tok = params.get('token');
            if (url && tok) { setRelayUrl(url); setToken(tok); setScanning(false); }
            else Alert.alert('Invalid QR', 'Could not read relay config from this QR code.');
        } catch { Alert.alert('Scan error', 'Could not parse QR code.'); }
    };

    const save = async () => {
        if (!relayUrl || !token) { Alert.alert('Missing fields', 'Scan the relay QR or fill both fields.'); return; }
        setTesting(true);
        try {
            await AsyncStorage.setItem('relay_url', relayUrl.replace(/\/$/, ''));
            await AsyncStorage.setItem('api_token', token.trim());
            const status = await fetchStatus();
            Alert.alert('✅ Connected!', `Relay online · ${status.connected_hosts} host(s)`, [{ text: 'Go to Dashboard', onPress: onDone }]);
        } catch (e: any) { Alert.alert('Connection failed', e.message); }
        finally { setTesting(false); }
    };

    // ── QR Scanner ────────────────────────────────────────
    if (scanning) {
        return (
            <View style={styles.root}>
                <CameraView
                    style={StyleSheet.absoluteFill}
                    facing="back"
                    barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
                    onBarcodeScanned={onBarcodeScanned}
                />
                <View style={styles.scanOverlay}>
                    <View style={styles.scanFrame} />
                    <Text style={styles.scanHint}>Point at the QR printed by your relay server</Text>
                    <TouchableOpacity style={styles.cancelBtn} onPress={() => setScanning(false)}>
                        <Text style={styles.cancelText}>Cancel</Text>
                    </TouchableOpacity>
                </View>
            </View>
        );
    }

    // ── Setup form ────────────────────────────────────────
    return (
        <KeyboardAvoidingView style={styles.root} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
            <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
                <View style={styles.hero}>
                    <View style={styles.logoRing}>
                        <Ionicons name="lock-closed" size={48} color="#5865F2" />
                    </View>
                    <Text style={styles.title}>OpenSSH</Text>
                    <Text style={styles.subtitle}>Connect to your relay server</Text>
                </View>

                {/* QR scan button */}
                <TouchableOpacity style={styles.qrBtn} onPress={handleScan}>
                    <Ionicons name="qr-code-outline" size={40} color="#5865F2" />
                    <View>
                        <Text style={styles.qrBtnTitle}>Scan Relay QR Code</Text>
                        <Text style={styles.qrBtnSub}>Shown in the relay terminal on startup</Text>
                    </View>
                </TouchableOpacity>

                <Text style={styles.orDivider}>— or enter manually —</Text>

                <View style={styles.card}>
                    <Text style={styles.label}>Relay URL</Text>
                    <TextInput
                        style={styles.input}
                        value={relayUrl}
                        onChangeText={setRelayUrl}
                        placeholder="http://1.2.3.4:8080"
                        placeholderTextColor="#BDBDBD"
                        autoCapitalize="none"
                        autoCorrect={false}
                        keyboardType="url"
                    />
                    <Text style={styles.label}>API Token</Text>
                    <TextInput
                        style={styles.input}
                        value={token}
                        onChangeText={setToken}
                        placeholder="Paste token from relay log"
                        placeholderTextColor="#BDBDBD"
                        autoCapitalize="none"
                        autoCorrect={false}
                        secureTextEntry
                    />
                    <TouchableOpacity style={styles.btn} onPress={save} disabled={testing}>
                        {testing ? <ActivityIndicator color="#fff" /> : <Text style={styles.btnText}>Connect & Save</Text>}
                    </TouchableOpacity>
                </View>
            </ScrollView>
        </KeyboardAvoidingView>
    );
}

const styles = StyleSheet.create({
    root: { flex: 1, backgroundColor: '#F2F2F7' },
    scroll: { flexGrow: 1, justifyContent: 'center', padding: 24 },
    hero: { alignItems: 'center', marginBottom: 32 },
    logoRing: {
        width: 96, height: 96, borderRadius: 28, backgroundColor: '#FFFFFF',
        alignItems: 'center', justifyContent: 'center', marginBottom: 12,
        shadowColor: '#000', shadowOpacity: 0.08, shadowRadius: 12, shadowOffset: { width: 0, height: 4 }, elevation: 4,
    },
    title: { fontSize: 34, fontWeight: '800', color: '#1C1C1E', letterSpacing: 0.5 },
    subtitle: { fontSize: 15, color: '#8E8E93', marginTop: 4 },

    qrBtn: {
        backgroundColor: '#FFFFFF', borderRadius: 18, padding: 18,
        flexDirection: 'row', alignItems: 'center', gap: 14, marginBottom: 16,
        borderWidth: 1.5, borderColor: '#5865F2',
        shadowColor: '#5865F2', shadowOpacity: 0.1, shadowRadius: 8, shadowOffset: { width: 0, height: 2 }, elevation: 2,
    },
    qrBtnTitle: { color: '#1C1C1E', fontWeight: '700', fontSize: 16 },
    qrBtnSub: { color: '#8E8E93', fontSize: 13, marginTop: 2 },

    orDivider: { color: '#C7C7CC', fontSize: 13, textAlign: 'center', marginVertical: 14 },

    card: {
        backgroundColor: '#FFFFFF', borderRadius: 20, padding: 20,
        shadowColor: '#000', shadowOpacity: 0.06, shadowRadius: 12, shadowOffset: { width: 0, height: 2 }, elevation: 2,
    },
    label: { color: '#8E8E93', fontSize: 12, fontWeight: '600', marginBottom: 8, marginTop: 12, textTransform: 'uppercase', letterSpacing: 0.5 },
    input: {
        backgroundColor: '#F2F2F7', borderRadius: 12, borderWidth: 1, borderColor: '#E5E5EA',
        color: '#1C1C1E', padding: 14, fontSize: 15,
    },
    btn: { backgroundColor: '#5865F2', borderRadius: 14, padding: 16, alignItems: 'center', marginTop: 20 },
    btnText: { color: '#FFF', fontWeight: '700', fontSize: 16 },

    // Camera
    scanOverlay: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center', gap: 24 },
    scanFrame: { width: 260, height: 260, borderWidth: 3, borderColor: '#5865F2', borderRadius: 24, backgroundColor: 'transparent' },
    scanHint: { color: '#FFF', fontSize: 14, textAlign: 'center', paddingHorizontal: 40, backgroundColor: 'rgba(0,0,0,0.55)', padding: 10, borderRadius: 10 },
    cancelBtn: { backgroundColor: '#FF3B30', borderRadius: 14, paddingHorizontal: 28, paddingVertical: 12 },
    cancelText: { color: '#FFF', fontWeight: '700', fontSize: 15 },
});
