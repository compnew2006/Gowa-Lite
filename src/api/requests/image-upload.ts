import type {ImageUploadPayload} from '@/api/contracts/chats';

export async function fileToImageUpload(file: File): Promise<ImageUploadPayload> {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return {
    filename: file.name || 'image.png',
    mimeType: file.type || 'image/png',
    dataBase64: btoa(binary),
  };
}

// Auth & Setup
