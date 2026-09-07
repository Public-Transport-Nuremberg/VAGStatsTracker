const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
    clearActiveRecording,
    getActiveRecording,
    getRecordingLogs,
    setActiveRecording,
} = require('./index');

const recordingDirectory = path.resolve(
    process.env.API_TRACE_DIRECTORY || path.join(__dirname, '..', '..', 'data', 'api-traces')
);
const indexPath = path.join(recordingDirectory, 'index.json');
let finalizePromise = null;

const ensureDirectory = () => fs.mkdirSync(recordingDirectory, { recursive: true });
const tokenHash = (token) => crypto.createHash('sha256').update(token).digest('hex');
const safeEqual = (left, right) => {
    const a = Buffer.from(String(left));
    const b = Buffer.from(String(right));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
};

const readIndex = () => {
    ensureDirectory();
    try {
        const value = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
        return Array.isArray(value) ? value : [];
    } catch (error) {
        if (error.code === 'ENOENT') return [];
        throw error;
    }
};

const writeIndex = (recordings) => {
    ensureDirectory();
    const temporaryPath = `${indexPath}.${process.pid}.tmp`;
    fs.writeFileSync(temporaryPath, JSON.stringify(recordings, null, 2));
    fs.renameSync(temporaryPath, indexPath);
};

const publicMetadata = ({ shareTokenHash, fileName, ...recording }) => ({
    ...recording,
    available: Boolean(fileName),
});

const listRecordings = async () => {
    await finalizeExpiredRecording();
    return readIndex()
        .map(publicMetadata)
        .sort((left, right) => new Date(right.startedAt) - new Date(left.startedAt));
};

const startRecording = async (hours) => {
    await finalizeExpiredRecording();
    const active = await getActiveRecording();
    if (active) {
        const error = new Error('Eine API-Aufnahme läuft bereits.');
        error.status = 409;
        throw error;
    }

    const startedAt = new Date();
    const shareToken = crypto.randomBytes(32).toString('base64url');
    const recording = {
        id: crypto.randomUUID(),
        state: 'recording',
        hours,
        startedAt: startedAt.toISOString(),
        endsAt: new Date(startedAt.getTime() + hours * 60 * 60 * 1000).toISOString(),
        shareTokenHash: tokenHash(shareToken),
    };
    const recordings = readIndex();
    recordings.push(recording);
    writeIndex(recordings);
    await setActiveRecording({
        id: recording.id,
        startedAt: recording.startedAt,
        endsAt: recording.endsAt,
    });
    return { ...publicMetadata(recording), shareToken };
};

const finalizeRecording = async (recordingId, reason = 'completed') => {
    if (finalizePromise) return finalizePromise;
    finalizePromise = (async () => {
        const recordings = readIndex();
        const index = recordings.findIndex((entry) => entry.id === recordingId);
        if (index === -1) throw Object.assign(new Error('Aufnahme nicht gefunden.'), { status: 404 });
        const recording = recordings[index];
        if (recording.state !== 'recording') return publicMetadata(recording);

        await clearActiveRecording(recordingId);
        const entries = await getRecordingLogs(recordingId);
        const stoppedAt = new Date().toISOString();
        const fileName = `${recording.id}.json`;
        const payload = {
            format: 'vagstats-api-trace',
            version: 1,
            recording: {
                id: recording.id,
                state: 'completed',
                hours: recording.hours,
                startedAt: recording.startedAt,
                endsAt: recording.endsAt,
                stoppedAt,
                reason,
                entryCount: entries.length,
            },
            entries,
        };
        fs.writeFileSync(path.join(recordingDirectory, fileName), JSON.stringify(payload));
        recordings[index] = {
            ...recording,
            state: 'completed',
            stoppedAt,
            reason,
            entryCount: entries.length,
            fileName,
        };
        writeIndex(recordings);
        return publicMetadata(recordings[index]);
    })();
    try { return await finalizePromise; } finally { finalizePromise = null; }
};

const stopRecording = async () => {
    const active = await getActiveRecording();
    if (!active) throw Object.assign(new Error('Es läuft keine API-Aufnahme.'), { status: 409 });
    return finalizeRecording(active.id, 'stopped');
};

const finalizeExpiredRecording = async () => {
    const active = await getActiveRecording();
    if (!active || new Date(active.endsAt).getTime() > Date.now()) return null;
    return finalizeRecording(active.id, 'duration-reached');
};

const findByShareToken = (shareToken) => {
    if (!shareToken) return null;
    const hash = tokenHash(String(shareToken));
    return readIndex().find((recording) => safeEqual(recording.shareTokenHash, hash)) || null;
};

const loadRecording = async (recording, allowActive = true) => {
    await finalizeExpiredRecording();
    const current = readIndex().find((entry) => entry.id === recording.id);
    if (!current) throw Object.assign(new Error('Aufnahme nicht gefunden.'), { status: 404 });
    if (current.fileName) {
        return JSON.parse(fs.readFileSync(path.join(recordingDirectory, current.fileName), 'utf8'));
    }
    if (!allowActive) throw Object.assign(new Error('Die Aufnahme ist noch nicht abgeschlossen.'), { status: 409 });
    const entries = await getRecordingLogs(current.id);
    return {
        format: 'vagstats-api-trace',
        version: 1,
        recording: { ...publicMetadata(current), entryCount: entries.length },
        entries,
    };
};

const getRecording = async (id) => {
    const recording = readIndex().find((entry) => entry.id === id);
    if (!recording) throw Object.assign(new Error('Aufnahme nicht gefunden.'), { status: 404 });
    return loadRecording(recording);
};

const getSharedRecording = async (shareToken) => {
    const recording = findByShareToken(shareToken);
    if (!recording) throw Object.assign(new Error('Ungültiger Share-Token.'), { status: 404 });
    return loadRecording(recording);
};

const recordingTimer = setInterval(() => finalizeExpiredRecording().catch((error) => {
    process.log?.error?.(`API trace recording finalization failed: ${error.message}`);
}), 5000);
recordingTimer.unref();
setImmediate(() => finalizeExpiredRecording().catch(() => {}));

module.exports = {
    finalizeExpiredRecording,
    getRecording,
    getSharedRecording,
    listRecordings,
    startRecording,
    stopRecording,
};
