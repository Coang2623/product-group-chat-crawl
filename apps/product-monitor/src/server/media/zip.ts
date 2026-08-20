import { crc32 } from "node:zlib";

export type ZipEntry = { name: string; bytes: Uint8Array };

const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_HEADER_SIGNATURE = 0x02014b50;
const END_OF_DIRECTORY_SIGNATURE = 0x06054b50;
/** Store, not deflate: product photos are already-compressed JPEG. */
const STORED = 0;
const VERSION_NEEDED = 20;
const UTF8_FLAG = 0x0800;

/**
 * Builds an uncompressed ZIP so a whole product's photos download in one file.
 * Avoids pulling in an archiver dependency for what is a fixed 30-byte header format.
 */
export const buildZip = (entries: ZipEntry[]): Buffer => {
    const locals: Buffer[] = [];
    const centrals: Buffer[] = [];
    let offset = 0;

    for (const entry of entries) {
        const name = Buffer.from(entry.name, "utf8");
        const body = Buffer.from(entry.bytes);
        const checksum = crc32(body);

        const local = Buffer.alloc(30 + name.length);
        local.writeUInt32LE(LOCAL_HEADER_SIGNATURE, 0);
        local.writeUInt16LE(VERSION_NEEDED, 4);
        local.writeUInt16LE(UTF8_FLAG, 6);
        local.writeUInt16LE(STORED, 8);
        // DOS time/date are left at zero: no timestamp is better than a wrong one.
        local.writeUInt32LE(checksum, 14);
        local.writeUInt32LE(body.length, 18);
        local.writeUInt32LE(body.length, 22);
        local.writeUInt16LE(name.length, 26);
        name.copy(local, 30);
        locals.push(local, body);

        const central = Buffer.alloc(46 + name.length);
        central.writeUInt32LE(CENTRAL_HEADER_SIGNATURE, 0);
        central.writeUInt16LE(VERSION_NEEDED, 4);
        central.writeUInt16LE(VERSION_NEEDED, 6);
        central.writeUInt16LE(UTF8_FLAG, 8);
        central.writeUInt16LE(STORED, 10);
        central.writeUInt32LE(checksum, 16);
        central.writeUInt32LE(body.length, 20);
        central.writeUInt32LE(body.length, 24);
        central.writeUInt16LE(name.length, 28);
        central.writeUInt32LE(offset, 42);
        name.copy(central, 46);
        centrals.push(central);

        offset += local.length + body.length;
    }

    const directory = Buffer.concat(centrals);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(END_OF_DIRECTORY_SIGNATURE, 0);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(directory.length, 12);
    end.writeUInt32LE(offset, 16);

    return Buffer.concat([...locals, directory, end]);
};
