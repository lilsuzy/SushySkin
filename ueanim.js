class BinaryReader {
    constructor(buffer) {
        this.bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
        this.view = new DataView(this.bytes.buffer, this.bytes.byteOffset, this.bytes.byteLength);
        this.offset = 0;
    }

    get remaining() {
        return this.bytes.byteLength - this.offset;
    }

    ensure(size) {
        if (!Number.isSafeInteger(size) || size < 0 || size > this.remaining) {
            throw new Error(`Invalid UEAnim data length at byte ${this.offset}.`);
        }
    }

    readUint8() {
        this.ensure(1);
        return this.view.getUint8(this.offset++);
    }

    readInt32() {
        this.ensure(4);
        const value = this.view.getInt32(this.offset, true);
        this.offset += 4;
        return value;
    }

    readFloat32() {
        this.ensure(4);
        const value = this.view.getFloat32(this.offset, true);
        this.offset += 4;
        return value;
    }

    readString() {
        const length = this.readInt32();
        if (length < 0 || length > this.remaining || length > 1_000_000) {
            throw new Error(`Invalid UEAnim string length: ${length}.`);
        }
        const value = new TextDecoder().decode(this.bytes.subarray(this.offset, this.offset + length));
        this.offset += length;
        return value.replace(/\0$/, '');
    }

    readChunk(length) {
        this.ensure(length);
        const chunk = new BinaryReader(this.bytes.subarray(this.offset, this.offset + length));
        this.offset += length;
        return chunk;
    }

    readCount(minimumItemBytes = 1) {
        const count = this.readInt32();
        if (count < 0 || count > 1_000_000 || count * minimumItemBytes > this.remaining) {
            throw new Error(`Invalid UEAnim array length: ${count}.`);
        }
        return count;
    }
}

function readVectorKeys(reader) {
    const count = reader.readCount(16);
    return Array.from({ length: count }, () => ({
        frame: reader.readInt32(),
        x: reader.readFloat32(),
        y: reader.readFloat32(),
        z: reader.readFloat32(),
    }));
}

function readQuaternionKeys(reader) {
    const count = reader.readCount(20);
    return Array.from({ length: count }, () => ({
        frame: reader.readInt32(),
        x: reader.readFloat32(),
        y: reader.readFloat32(),
        z: reader.readFloat32(),
        w: reader.readFloat32(),
    }));
}

function readMetadata(reader) {
    return {
        numFrames: reader.readInt32(),
        framesPerSecond: reader.readFloat32(),
        referencePosePath: reader.readString(),
        additiveAnimationType: reader.readUint8(),
        additiveBasePoseType: reader.readUint8(),
        referenceFrameIndex: reader.readInt32(),
    };
}

function readTracks(reader, count) {
    if (count < 0 || count > 100_000 || count > reader.remaining / 4) {
        throw new Error(`Invalid UEAnim track count: ${count}.`);
    }

    return Array.from({ length: count }, () => ({
        boneName: reader.readString(),
        positionKeys: readVectorKeys(reader),
        rotationKeys: readQuaternionKeys(reader),
        scaleKeys: readVectorKeys(reader),
    }));
}

function readSection(reader, version) {
    const name = reader.readString();
    if (version >= 10) {
        let byteLength = reader.readInt32();
        const count = name === 'METADATA' ? 1 : reader.readInt32();
        if (name !== 'METADATA') byteLength -= 4;
        return { name, count, data: reader.readChunk(byteLength) };
    }

    const count = reader.readInt32();
    const byteLength = reader.readInt32();
    return { name, count, data: reader.readChunk(byteLength) };
}

export function parseUEAnim(buffer) {
    const reader = new BinaryReader(buffer);
    if (new TextDecoder().decode(reader.bytes.subarray(0, 8)) !== 'UEFORMAT') {
        throw new Error('The animation file is not a UEFormat file.');
    }
    reader.offset = 8;

    const identifier = reader.readString();
    if (identifier !== 'UEANIM') {
        throw new Error(`Expected a UEANIM file, received ${identifier || 'an unknown format'}.`);
    }

    const version = reader.readUint8();
    if (version < 9 || version > 10) {
        throw new Error(`UEAnim version ${version} is not supported.`);
    }

    const name = reader.readString();
    if (version >= 10) reader.readString();

    const compressed = reader.readUint8();
    if (compressed !== 0) {
        const format = reader.readString();
        throw new Error(`Compressed UEAnim files (${format}) are not supported by this test loader.`);
    }

    const sectionCount = version >= 10 ? reader.readCount(8) : null;
    const sectionsToRead = sectionCount ?? Number.POSITIVE_INFINITY;
    let metadata = null;
    let tracks = [];
    let sectionsRead = 0;

    while (reader.remaining > 0 && sectionsRead < sectionsToRead) {
        const section = readSection(reader, version);
        sectionsRead += 1;
        if (section.name === 'METADATA') {
            metadata = readMetadata(section.data);
        } else if (section.name === 'TRACKS') {
            tracks = readTracks(section.data, section.count);
        }
    }

    if (!metadata || !Number.isFinite(metadata.framesPerSecond) || metadata.framesPerSecond <= 0) {
        throw new Error(`UEAnim "${name}" is missing valid animation metadata.`);
    }

    return { name, metadata, tracks };
}

function toThreePosition({ x, y, z }) {
    return [x * 0.01, z * 0.01, y * 0.01];
}

function toThreeScale({ x, y, z }) {
    return [x, z, y];
}

function toThreeQuaternion({ x, y, z, w }) {
    return [x, z, y, -w];
}

function smoothVectorValues(values) {
    const result = values.slice();
    const keyCount = values.length / 3;
    for (let key = 1; key < keyCount - 1; key++) {
        const previous = (key - 1) * 3;
        const current = key * 3;
        const next = (key + 1) * 3;
        for (let axis = 0; axis < 3; axis++) {
            result[current + axis] = (values[previous + axis] + 2 * values[current + axis] + values[next + axis]) * 0.25;
        }
    }
    return result;
}

function smoothQuaternionValues(values, THREE) {
    const keyCount = values.length / 4;
    if (keyCount < 3) return values;

    const normalized = values.slice();
    let previous = new THREE.Quaternion();
    for (let key = 0; key < keyCount; key++) {
        const offset = key * 4;
        let current = new THREE.Quaternion(
            normalized[offset],
            normalized[offset + 1],
            normalized[offset + 2],
            normalized[offset + 3],
        ).normalize();
        if (key > 0) {
            const dot = previous.dot(current);
            if (dot < 0) {
                current = new THREE.Quaternion(-current.x, -current.y, -current.z, -current.w);
            }
        }
        normalized.set([current.x, current.y, current.z, current.w], offset);
        previous = current;
    }

    const result = normalized.slice();
    for (let key = 1; key < keyCount - 1; key++) {
        const previousOffset = (key - 1) * 4;
        const currentOffset = key * 4;
        const nextOffset = (key + 1) * 4;
        const previous = new THREE.Quaternion(...normalized.subarray(previousOffset, previousOffset + 4));
        const current = new THREE.Quaternion(...normalized.subarray(currentOffset, currentOffset + 4));
        const next = new THREE.Quaternion(...normalized.subarray(nextOffset, nextOffset + 4));
        const left = previous.clone().slerp(current, 0.5);
        const right = current.clone().slerp(next, 0.5);
        const smoothed = left.slerp(right, 0.5).normalize();
        result.set([smoothed.x, smoothed.y, smoothed.z, smoothed.w], currentOffset);
    }
    return result;
}

const unstableFaceBones = new Set(['DinoRightFenestra', 'DinoLeftFenestra']);

export function buildUEAnimationClip(animation, THREE, compatibleBoneNames) {
    const { framesPerSecond, numFrames } = animation.metadata;
    const tracks = [];

    for (const track of animation.tracks) {
        if (!compatibleBoneNames.has(track.boneName)) continue;

        if (track.positionKeys.length) {
            const times = new Float32Array(track.positionKeys.length);
            const values = new Float32Array(track.positionKeys.length * 3);
            track.positionKeys.forEach((key, index) => {
                times[index] = key.frame / framesPerSecond;
                values.set(toThreePosition(key), index * 3);
            });
            tracks.push(new THREE.VectorKeyframeTrack(`${track.boneName}.position`, times, smoothVectorValues(values)));
        }

        if (track.rotationKeys.length && !unstableFaceBones.has(track.boneName)) {
            const times = new Float32Array(track.rotationKeys.length);
            const values = new Float32Array(track.rotationKeys.length * 4);
            track.rotationKeys.forEach((key, index) => {
                times[index] = key.frame / framesPerSecond;
                values.set(toThreeQuaternion(key), index * 4);
            });
            tracks.push(new THREE.QuaternionKeyframeTrack(`${track.boneName}.quaternion`, times, smoothQuaternionValues(values, THREE)));
        }

        if (track.scaleKeys.length) {
            const times = new Float32Array(track.scaleKeys.length);
            const values = new Float32Array(track.scaleKeys.length * 3);
            track.scaleKeys.forEach((key, index) => {
                times[index] = key.frame / framesPerSecond;
                const sign = key.x < 0 && key.y < 0 && key.z < 0 ? -1 : 1;
                values.set(toThreeScale(key).map(value => value * sign), index * 3);
            });
            tracks.push(new THREE.VectorKeyframeTrack(`${track.boneName}.scale`, times, smoothVectorValues(values)));
        }
    }

    const duration = numFrames > 0 ? numFrames / framesPerSecond : -1;
    return new THREE.AnimationClip(animation.name, duration, tracks);
}
