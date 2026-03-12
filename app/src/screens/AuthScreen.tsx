import React, { useState } from 'react';
import {
    View, Text, TextInput, TouchableOpacity, StyleSheet,
    KeyboardAvoidingView, Platform, ScrollView, ActivityIndicator, Alert,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';

interface Props {
    onDone: () => void;
}

export default function AuthScreen({ onDone }: Props) {
    const [mode, setMode] = useState<'login' | 'register'>('login');
    const [relayUrl, setRelayUrl] = useState('');
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [name, setName] = useState('');
    const [loading, setLoading] = useState(false);

    const submit = async () => {
        if (!relayUrl || !email || !password) {
            Alert.alert('Missing fields', 'Please fill in relay URL, email, and password.');
            return;
        }
        if (mode === 'register' && password.length < 6) {
            Alert.alert('Weak password', 'Password must be at least 6 characters.');
            return;
        }

        setLoading(true);
        try {
            const url = relayUrl.replace(/\/$/, '');
            const endpoint = mode === 'register' ? '/api/register' : '/api/login';
            const body: Record<string, string> = { email, password };
            if (mode === 'register' && name) body.name = name;

            const res = await fetch(`${url}${endpoint}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });

            const data = await res.json();

            if (!res.ok) {
                Alert.alert('Error', data.error || `HTTP ${res.status}`);
                return;
            }

            // Save credentials
            await AsyncStorage.setItem('relay_url', url);
            await AsyncStorage.setItem('api_token', data.token);
            await AsyncStorage.setItem('user_id', data.user_id);

            Alert.alert(
                mode === 'register' ? '🎉 Account Created!' : '✅ Logged In!',
                'Connected to relay.',
                [{ text: 'Go to Dashboard', onPress: onDone }]
            );
        } catch (e: any) {
            Alert.alert('Connection error', e.message || 'Could not reach relay.');
        } finally {
            setLoading(false);
        }
    };

    return (
        <KeyboardAvoidingView style={styles.root} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
            <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
                <View style={styles.hero}>
                    <View style={styles.logoRing}>
                        <Ionicons name="terminal" size={44} color="#000" />
                    </View>
                    <Text style={styles.title}>OpenSSH</Text>
                    <Text style={styles.subtitle}>
                        {mode === 'login' ? 'Sign in to your relay' : 'Create a new account'}
                    </Text>
                </View>

                {/* Tabs */}
                <View style={styles.tabs}>
                    <TouchableOpacity
                        style={[styles.tab, mode === 'login' && styles.tabActive]}
                        onPress={() => setMode('login')}
                    >
                        <Text style={[styles.tabText, mode === 'login' && styles.tabTextActive]}>Log In</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                        style={[styles.tab, mode === 'register' && styles.tabActive]}
                        onPress={() => setMode('register')}
                    >
                        <Text style={[styles.tabText, mode === 'register' && styles.tabTextActive]}>Register</Text>
                    </TouchableOpacity>
                </View>

                <View style={styles.card}>
                    <Text style={styles.label}>Relay URL</Text>
                    <TextInput
                        style={styles.input}
                        value={relayUrl}
                        onChangeText={setRelayUrl}
                        placeholder="http://your-relay:8080"
                        placeholderTextColor="#999"
                        autoCapitalize="none"
                        autoCorrect={false}
                        keyboardType="url"
                    />

                    {mode === 'register' && (
                        <>
                            <Text style={styles.label}>Name</Text>
                            <TextInput
                                style={styles.input}
                                value={name}
                                onChangeText={setName}
                                placeholder="Your name (optional)"
                                placeholderTextColor="#999"
                                autoCapitalize="words"
                            />
                        </>
                    )}

                    <Text style={styles.label}>Email</Text>
                    <TextInput
                        style={styles.input}
                        value={email}
                        onChangeText={setEmail}
                        placeholder="you@example.com"
                        placeholderTextColor="#999"
                        autoCapitalize="none"
                        autoCorrect={false}
                        keyboardType="email-address"
                    />

                    <Text style={styles.label}>Password</Text>
                    <TextInput
                        style={styles.input}
                        value={password}
                        onChangeText={setPassword}
                        placeholder={mode === 'register' ? 'Min 6 characters' : 'Your password'}
                        placeholderTextColor="#999"
                        secureTextEntry
                    />

                    <TouchableOpacity style={styles.btn} onPress={submit} disabled={loading}>
                        {loading
                            ? <ActivityIndicator color="#000" />
                            : <Text style={styles.btnText}>{mode === 'register' ? 'Create Account' : 'Log In'}</Text>
                        }
                    </TouchableOpacity>
                </View>

                {/* Legacy setup link */}
                <TouchableOpacity style={styles.legacyLink} onPress={() => {
                    Alert.alert(
                        'Admin Setup',
                        'If you\'re running a private relay with a CLI token, use the manual setup screen.',
                        [
                            { text: 'Cancel', style: 'cancel' },
                            {
                                text: 'Manual Setup', onPress: () => {
                                    // Navigate to legacy setup — handled by parent
                                    (onDone as any).__legacySetup?.();
                                }
                            },
                        ]
                    );
                }}>
                    <Text style={styles.legacyText}>Using a private relay? Manual setup →</Text>
                </TouchableOpacity>
            </ScrollView>
        </KeyboardAvoidingView>
    );
}

const styles = StyleSheet.create({
    root: { flex: 1, backgroundColor: '#000' },
    scroll: { flexGrow: 1, justifyContent: 'center', padding: 24 },

    hero: { alignItems: 'center', marginBottom: 28 },
    logoRing: {
        width: 88, height: 88, borderRadius: 24, backgroundColor: '#fff',
        alignItems: 'center', justifyContent: 'center', marginBottom: 12,
    },
    title: { fontSize: 32, fontWeight: '800', color: '#fff', letterSpacing: 0.5 },
    subtitle: { fontSize: 14, color: '#888', marginTop: 4 },

    tabs: {
        flexDirection: 'row', backgroundColor: '#111', borderRadius: 14,
        padding: 4, marginBottom: 20,
    },
    tab: {
        flex: 1, paddingVertical: 12, borderRadius: 12, alignItems: 'center',
    },
    tabActive: { backgroundColor: '#fff' },
    tabText: { color: '#888', fontWeight: '600', fontSize: 15 },
    tabTextActive: { color: '#000' },

    card: {
        backgroundColor: '#111', borderRadius: 20, padding: 20,
        borderWidth: 1, borderColor: '#222',
    },
    label: {
        color: '#888', fontSize: 11, fontWeight: '600', marginBottom: 6, marginTop: 14,
        textTransform: 'uppercase', letterSpacing: 0.8,
    },
    input: {
        backgroundColor: '#000', borderRadius: 12, borderWidth: 1, borderColor: '#333',
        color: '#fff', padding: 14, fontSize: 15,
    },
    btn: {
        backgroundColor: '#fff', borderRadius: 14, padding: 16,
        alignItems: 'center', marginTop: 22,
    },
    btnText: { color: '#000', fontWeight: '700', fontSize: 16 },

    legacyLink: { alignItems: 'center', marginTop: 20, padding: 12 },
    legacyText: { color: '#555', fontSize: 13 },
});
