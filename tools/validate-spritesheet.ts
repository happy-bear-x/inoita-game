const MAX_SPRITESHEET_SIZE = 4096;

export function validateSpriteSheet(header: Uint8Array, clip: { frameWidth: number; frameHeight: number; frames: number }, file: string): void {
  const fail = (reason: string): never => { throw new Error(`动画图集 ${file}：${reason}`); };
  const signature = [137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82];
  if (header.length < 24 || signature.some((byte, index) => header[index] !== byte)) fail('PNG 头无效');
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  const width = view.getUint32(16), height = view.getUint32(20);
  if (!width || !height || width > MAX_SPRITESHEET_SIZE || height > MAX_SPRITESHEET_SIZE) fail(`尺寸 ${width}×${height} 超出 1–${MAX_SPRITESHEET_SIZE} 像素`);
  if (width % clip.frameWidth || height % clip.frameHeight) fail('图片尺寸不是帧尺寸的整数倍');
  if (width / clip.frameWidth * (height / clip.frameHeight) < clip.frames) fail(`不足 ${clip.frames} 帧`);
}
