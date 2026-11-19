import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { BlobServiceClient, type ContainerClient } from '@azure/storage-blob';
import type { TokenCredential } from '@azure/identity';

export interface BlobInfo {
  stream: Readable;
  size: number;
  contentType: string;
}

export interface BlobStore {
  init(): Promise<void>;
  putStream(name: string, data: Readable, contentType: string): Promise<number>;
  putText(name: string, text: string): Promise<void>;
  getBuffer(name: string): Promise<Buffer>;
  getText(name: string): Promise<string | undefined>;
  open(name: string): Promise<BlobInfo | undefined>;
  delete(name: string): Promise<void>;
}

export class AzureBlobStore implements BlobStore {
  private container: ContainerClient;

  constructor(accountUrl: string, containerName: string, credential: TokenCredential) {
    this.container = new BlobServiceClient(accountUrl, credential).getContainerClient(containerName);
  }

  async init(): Promise<void> {
    await this.container.createIfNotExists();
  }

  async putStream(name: string, data: Readable, contentType: string): Promise<number> {
    let size = 0;
    data.on('data', (chunk: Buffer) => (size += chunk.length));
    await this.container.getBlockBlobClient(name).uploadStream(data, 4 * 1024 * 1024, 4, {
      blobHTTPHeaders: { blobContentType: contentType },
    });
    return size;
  }

  async putText(name: string, text: string): Promise<void> {
    const buf = Buffer.from(text, 'utf8');
    await this.container.getBlockBlobClient(name).uploadData(buf, {
      blobHTTPHeaders: { blobContentType: 'text/plain; charset=utf-8' },
    });
  }

  async getBuffer(name: string): Promise<Buffer> {
    return this.container.getBlockBlobClient(name).downloadToBuffer();
  }

  async getText(name: string): Promise<string | undefined> {
    try {
      return (await this.getBuffer(name)).toString('utf8');
    } catch (err) {
      if ((err as { statusCode?: number }).statusCode === 404) return undefined;
      throw err;
    }
  }

  async open(name: string): Promise<BlobInfo | undefined> {
    try {
      const res = await this.container.getBlockBlobClient(name).download();
      return {
        stream: res.readableStreamBody as Readable,
        size: res.contentLength ?? 0,
        contentType: res.contentType ?? 'application/octet-stream',
      };
    } catch (err) {
      if ((err as { statusCode?: number }).statusCode === 404) return undefined;
      throw err;
    }
  }

  async delete(name: string): Promise<void> {
    await this.container.getBlockBlobClient(name).deleteIfExists();
  }
}

/** Filesystem-backed store for local development. */
export class LocalBlobStore implements BlobStore {
  constructor(private root: string) {}

  private file(name: string): string {
    const full = path.resolve(this.root, name);
    if (!full.startsWith(path.resolve(this.root))) throw new Error('invalid blob name');
    return full;
  }

  async init(): Promise<void> {
    await mkdir(this.root, { recursive: true });
  }

  async putStream(name: string, data: Readable, contentType: string): Promise<number> {
    const f = this.file(name);
    await mkdir(path.dirname(f), { recursive: true });
    await pipeline(data, createWriteStream(f));
    await writeFile(`${f}.meta`, contentType);
    return (await stat(f)).size;
  }

  async putText(name: string, text: string): Promise<void> {
    await this.putStream(name, Readable.from([Buffer.from(text, 'utf8')]), 'text/plain; charset=utf-8');
  }

  async getBuffer(name: string): Promise<Buffer> {
    return readFile(this.file(name));
  }

  async getText(name: string): Promise<string | undefined> {
    try {
      return await readFile(this.file(name), 'utf8');
    } catch {
      return undefined;
    }
  }

  async open(name: string): Promise<BlobInfo | undefined> {
    const f = this.file(name);
    try {
      const s = await stat(f);
      const contentType = await readFile(`${f}.meta`, 'utf8').catch(() => 'application/octet-stream');
      return { stream: createReadStream(f), size: s.size, contentType };
    } catch {
      return undefined;
    }
  }

  async delete(name: string): Promise<void> {
    const f = this.file(name);
    await rm(f, { force: true });
    await rm(`${f}.meta`, { force: true });
  }
}
