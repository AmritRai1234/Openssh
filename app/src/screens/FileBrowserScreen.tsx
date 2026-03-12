import React, { useState, useEffect, useCallback } from 'react';
import {
    View, Text, TouchableOpacity, StyleSheet, FlatList,
    ActivityIndicator, Alert, Platform, StatusBar,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { HostInfo } from '../api/relay';

// ─────────────────────────────────────────────────────────
//  Types
// ─────────────────────────────────────────────────────────

interface FileEntry {
    name: string;
    is_dir: boolean;
    size: number;
    modified_secs: number;
}

interface Props {
    host: HostInfo;
    onBack: () => void;
}

// ─────────────────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────────────────

function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function formatDate(unixSecs: number): string {
    if (!unixSecs) return '';
    const d = new Date(unixSecs * 1000);
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function fileIcon(entry: FileEntry): string {
    if (entry.is_dir) return 'folder';
    const ext = entry.name.split('.').pop()?.toLowerCase() ?? '';
    if (['jpg', 'jpeg', 'png', 'gif', 'svg', 'webp', 'bmp'].includes(ext)) return 'image-outline';
    if (['mp4', 'mov', 'avi', 'mkv', 'webm'].includes(ext)) return 'videocam-outline';
    if (['mp3', 'wav', 'flac', 'ogg', 'aac'].includes(ext)) return 'musical-note-outline';
    if (['zip', 'tar', 'gz', 'bz2', 'xz', '7z', 'rar'].includes(ext)) return 'archive-outline';
    if (['pdf'].includes(ext)) return 'document-text-outline';
    if (['rs', 'ts', 'tsx', 'js', 'py', 'c', 'cpp', 'h', 'go', 'java', 'rb', 'sh'].includes(ext)) return 'code-slash-outline';
    return 'document-outline';
}

function iconColor(entry: FileEntry): string {
    if (entry.is_dir) return '#5865F2';
    const ext = entry.name.split('.').pop()?.toLowerCase() ?? '';
    if (['jpg', 'jpeg', 'png', 'gif', 'svg', 'webp'].includes(ext)) return '#FF9500';
    if (['rs', 'ts', 'tsx', 'js', 'py'].includes(ext)) return '#30D158';
    return '#8E8E93';
}

// ─────────────────────────────────────────────────────────
//  Component
// ─────────────────────────────────────────────────────────

export default function FileBrowserScreen({ host, onBack }: Props) {
    const [path, setPath] = useState('/');
    const [entries, setEntries] = useState<FileEntry[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [filePreview, setFilePreview] = useState<{ name: string; content: string } | null>(null);

    const loadDir = useCallback(async (dirPath: string) => {
        setLoading(true);
        setError(null);
        setFilePreview(null);
        try {
            const relayUrl = (await AsyncStorage.getItem('relay_url')) ?? '';
            const token = (await AsyncStorage.getItem('api_token')) ?? '';
            if (!relayUrl || !token) throw new Error('Not configured');

            const wsUrl = `${relayUrl.replace(/^http/, 'ws')}/api/terminal/${host.id}?token=${encodeURIComponent(token)}`;
            // Use a temporary WebSocket to send the FS command
            // For now, we'll use the HTTP-based approach via a simple shell command
            // through the terminal WebSocket
            const ws = new WebSocket(wsUrl);

            await new Promise<void>((resolve, reject) => {
                let output = '';
                let timeout = setTimeout(() => { ws.close(); reject(new Error('Timeout')); }, 8000);

                ws.onopen = () => {
                    // Send a shell command that outputs JSON directory listing
                    const cmd = `python3 -c "
import os, json, time
p = '${dirPath.replace(/'/g, "\\'")}'
try:
    entries = []
    for name in sorted(os.listdir(p)):
        full = os.path.join(p, name)
        try:
            st = os.stat(full)
            entries.append({'name': name, 'is_dir': os.path.isdir(full), 'size': st.st_size, 'modified_secs': int(st.st_mtime)})
        except: pass
    print('FILELIST_JSON:' + json.dumps(entries))
except Exception as e:
    print('FILELIST_ERROR:' + str(e))
" 2>/dev/null\n`;
                    ws.send(cmd);
                };

                ws.onmessage = (e) => {
                    const text = typeof e.data === 'string' ? e.data :
                        e.data instanceof ArrayBuffer ? new TextDecoder().decode(e.data) : '';
                    output += text;

                    // Check for our marker
                    const jsonMatch = output.match(/FILELIST_JSON:(\[.*?\])/s);
                    const errMatch = output.match(/FILELIST_ERROR:(.*)/);

                    if (jsonMatch) {
                        clearTimeout(timeout);
                        try {
                            const parsed = JSON.parse(jsonMatch[1]) as FileEntry[];
                            setEntries(parsed);
                            setPath(dirPath);
                        } catch (e) {
                            setError('Failed to parse directory listing');
                        }
                        ws.close();
                        resolve();
                    } else if (errMatch) {
                        clearTimeout(timeout);
                        setError(errMatch[1]);
                        ws.close();
                        resolve();
                    }
                };

                ws.onerror = () => { clearTimeout(timeout); reject(new Error('Connection failed')); };
                ws.onclose = () => { clearTimeout(timeout); resolve(); };
            });
        } catch (e: any) {
            setError(e.message);
        } finally {
            setLoading(false);
        }
    }, [host.id]);

    useEffect(() => {
        loadDir('/');
    }, []);

    const navigateTo = (entry: FileEntry) => {
        if (entry.is_dir) {
            const newPath = path === '/' ? `/${entry.name}` : `${path}/${entry.name}`;
            loadDir(newPath);
        } else {
            // Show basic file info
            Alert.alert(
                entry.name,
                `Size: ${formatSize(entry.size)}\nModified: ${formatDate(entry.modified_secs)}\nPath: ${path === '/' ? '/' : path}/${entry.name}`,
                [{ text: 'OK' }]
            );
        }
    };

    const goUp = () => {
        if (path === '/') return;
        const parts = path.split('/').filter(Boolean);
        parts.pop();
        loadDir('/' + parts.join('/') || '/');
    };

    const renderItem = ({ item }: { item: FileEntry }) => (
        <TouchableOpacity style={styles.fileRow} onPress={() => navigateTo(item)} activeOpacity={0.6}>
            <Ionicons name={fileIcon(item) as any} size={24} color={iconColor(item)} style={styles.fileIcon} />
            <View style={styles.fileInfo}>
                <Text style={[styles.fileName, item.is_dir && styles.dirName]} numberOfLines={1}>
                    {item.name}
                </Text>
                <Text style={styles.fileMeta}>
                    {item.is_dir ? 'Directory' : formatSize(item.size)}
                    {item.modified_secs ? `  ·  ${formatDate(item.modified_secs)}` : ''}
                </Text>
            </View>
            {item.is_dir && (
                <Ionicons name="chevron-forward" size={18} color="#C7C7CC" />
            )}
        </TouchableOpacity>
    );

    const sortedEntries = [...entries].sort((a, b) => {
        if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
        return a.name.localeCompare(b.name);
    });

    return (
        <View style={styles.root}>
            <StatusBar barStyle="dark-content" />

            {/* Header */}
            <View style={styles.header}>
                <TouchableOpacity onPress={onBack} style={styles.back}>
                    <Ionicons name="chevron-back" size={28} color="#5865F2" />
                </TouchableOpacity>
                <View style={styles.titleCol}>
                    <Text style={styles.title}>Files</Text>
                    <Text style={styles.subtitle} numberOfLines={1}>{host.id}</Text>
                </View>
                <TouchableOpacity onPress={() => loadDir(path)} style={styles.refreshBtn}>
                    <Ionicons name="refresh" size={20} color="#5865F2" />
                </TouchableOpacity>
            </View>

            {/* Breadcrumb / path bar */}
            <View style={styles.pathBar}>
                <TouchableOpacity onPress={goUp} disabled={path === '/'} style={styles.upBtn}>
                    <Ionicons name="arrow-up" size={18} color={path === '/' ? '#C7C7CC' : '#5865F2'} />
                </TouchableOpacity>
                <Text style={styles.pathText} numberOfLines={1}>{path}</Text>
            </View>

            {/* Content */}
            {loading ? (
                <View style={styles.center}>
                    <ActivityIndicator size="large" color="#5865F2" />
                    <Text style={styles.loadingText}>Loading...</Text>
                </View>
            ) : error ? (
                <View style={styles.center}>
                    <Ionicons name="alert-circle-outline" size={48} color="#FF453A" />
                    <Text style={styles.errorText}>{error}</Text>
                    <TouchableOpacity style={styles.retryBtn} onPress={() => loadDir(path)}>
                        <Text style={styles.retryText}>Retry</Text>
                    </TouchableOpacity>
                </View>
            ) : sortedEntries.length === 0 ? (
                <View style={styles.center}>
                    <Ionicons name="folder-open-outline" size={48} color="#C7C7CC" />
                    <Text style={styles.emptyText}>Empty directory</Text>
                </View>
            ) : (
                <FlatList
                    data={sortedEntries}
                    keyExtractor={item => item.name}
                    renderItem={renderItem}
                    contentContainerStyle={styles.list}
                    ItemSeparatorComponent={() => <View style={styles.separator} />}
                />
            )}
        </View>
    );
}

const styles = StyleSheet.create({
    root: { flex: 1, backgroundColor: '#F2F2F7' },
    header: {
        flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
        paddingTop: 56, paddingHorizontal: 16, paddingBottom: 14,
        backgroundColor: '#FFFFFF', borderBottomWidth: 1, borderColor: '#E5E5EA',
    },
    back: { padding: 8 },
    titleCol: { alignItems: 'center' },
    title: { color: '#1C1C1E', fontSize: 18, fontWeight: '700' },
    subtitle: { color: '#8E8E93', fontSize: 12, marginTop: 2 },
    refreshBtn: { padding: 8 },

    pathBar: {
        flexDirection: 'row', alignItems: 'center',
        backgroundColor: '#FFFFFF', paddingHorizontal: 16, paddingVertical: 10,
        borderBottomWidth: 1, borderColor: '#E5E5EA',
    },
    upBtn: { marginRight: 10, padding: 4 },
    pathText: {
        color: '#5865F2', fontSize: 13, fontWeight: '600',
        fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
        flex: 1,
    },

    center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
    loadingText: { color: '#8E8E93', marginTop: 12, fontSize: 14 },
    errorText: { color: '#FF453A', marginTop: 12, fontSize: 14, textAlign: 'center' },
    emptyText: { color: '#C7C7CC', marginTop: 12, fontSize: 14 },
    retryBtn: {
        marginTop: 16, backgroundColor: '#5865F2', borderRadius: 12,
        paddingHorizontal: 24, paddingVertical: 10,
    },
    retryText: { color: '#FFF', fontWeight: '700' },

    list: { paddingBottom: 32 },
    fileRow: {
        flexDirection: 'row', alignItems: 'center',
        backgroundColor: '#FFFFFF', paddingHorizontal: 16, paddingVertical: 14,
    },
    fileIcon: { marginRight: 14 },
    fileInfo: { flex: 1 },
    fileName: { color: '#1C1C1E', fontSize: 15, fontWeight: '500' },
    dirName: { color: '#5865F2', fontWeight: '600' },
    fileMeta: { color: '#8E8E93', fontSize: 12, marginTop: 2 },
    separator: { height: 1, backgroundColor: '#E5E5EA', marginLeft: 54 },
});
