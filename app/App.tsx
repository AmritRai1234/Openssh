import React, { useState, useEffect } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { View, ActivityIndicator, StyleSheet } from 'react-native';
import SetupScreen from './src/screens/SetupScreen';
import AuthScreen from './src/screens/AuthScreen';
import DashboardScreen from './src/screens/DashboardScreen';
import HostDetailScreen from './src/screens/HostDetailScreen';
import TerminalScreen from './src/screens/TerminalScreen';
import FileBrowserScreen from './src/screens/FileBrowserScreen';
import { HostInfo } from './src/api/relay';

type Screen = 'loading' | 'auth' | 'setup' | 'dashboard' | 'host' | 'terminal' | 'files';

export default function App() {
  const [screen, setScreen] = useState<Screen>('loading');
  const [selectedHost, setSelectedHost] = useState<HostInfo | null>(null);

  // On launch: check saved config and skip setup if already configured
  useEffect(() => {
    AsyncStorage.multiGet(['relay_url', 'api_token']).then((pairs) => {
      const url = pairs[0][1];
      const token = pairs[1][1];
      setScreen(url && token ? 'dashboard' : 'auth');
    }).catch(() => setScreen('setup'));
  }, []);

  // Neutral loading screen while AsyncStorage is checked
  if (screen === 'loading') {
    return (
      <View style={styles.loading}>
        <ActivityIndicator size="large" color="#5865F2" />
      </View>
    );
  }

  if (screen === 'auth') {
    return (
      <SafeAreaProvider>
        <AuthScreen onDone={() => setScreen('dashboard')} />
      </SafeAreaProvider>
    );
  }

  if (screen === 'setup') {
    return (
      <SafeAreaProvider>
        <SetupScreen onDone={() => setScreen('dashboard')} />
      </SafeAreaProvider>
    );
  }

  if (screen === 'dashboard') {
    return (
      <SafeAreaProvider>
        <DashboardScreen
          onSelectHost={(host) => { setSelectedHost(host); setScreen('host'); }}
          onSetup={() => setScreen('auth')}
        />
      </SafeAreaProvider>
    );
  }

  if (screen === 'host' && selectedHost) {
    return (
      <SafeAreaProvider>
        <HostDetailScreen
          host={selectedHost}
          onBack={() => setScreen('dashboard')}
          onTerminal={(host) => { setSelectedHost(host); setScreen('terminal'); }}
          onFiles={(host) => { setSelectedHost(host); setScreen('files'); }}
        />
      </SafeAreaProvider>
    );
  }

  if (screen === 'terminal' && selectedHost) {
    return (
      <SafeAreaProvider>
        <TerminalScreen host={selectedHost} onBack={() => setScreen('host')} />
      </SafeAreaProvider>
    );
  }

  if (screen === 'files' && selectedHost) {
    return (
      <SafeAreaProvider>
        <FileBrowserScreen host={selectedHost} onBack={() => setScreen('host')} />
      </SafeAreaProvider>
    );
  }

  return null;
}

const styles = StyleSheet.create({
  loading: { flex: 1, backgroundColor: '#F2F2F7', alignItems: 'center', justifyContent: 'center' },
});
