import { config } from '../config/config.js'

/** QQ 图片 URL 有效期有限，缓存只为了同一轮里图片被引用两次时少下一次 */
const IMAGE_CACHE = new Map()
const IMAGE_CACHE_MAX = 60

function rememberImage (url, value) {
  if (IMAGE_CACHE.size >= IMAGE_CACHE_MAX) {
    IMAGE_CACHE.delete(IMAGE_CACHE.keys().next().value)
  }
  IMAGE_CACHE.set(url, value)
}

/**
 * 从文件头嗅探图片尺寸。不解码像素，只读头部几十字节，
 * 因此不会引入 sharp / canvas 这类原生依赖。
 * @returns {{width: number, height: number, type: string}|null}
 */
export function sniffImageSize (buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 16) return null

  // PNG: 8 字节签名 + IHDR
  if (buffer[0] === 0x89 && buffer.toString('ascii', 1, 4) === 'PNG') {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20), type: 'image/png' }
  }

  // GIF: GIF87a / GIF89a，小端
  if (buffer.toString('ascii', 0, 3) === 'GIF') {
    return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8), type: 'image/gif' }
  }

  // WebP: RIFF....WEBP，三种子格式
  if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
    const chunk = buffer.toString('ascii', 12, 16)
    if (chunk === 'VP8X' && buffer.length >= 30) {
      const width = 1 + (buffer.readUIntLE(24, 3) & 0xffffff)
      const height = 1 + (buffer.readUIntLE(27, 3) & 0xffffff)
      return { width, height, type: 'image/webp' }
    }
    if (chunk === 'VP8 ' && buffer.length >= 30) {
      return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff, type: 'image/webp' }
    }
    if (chunk === 'VP8L' && buffer.length >= 25) {
      const bits = buffer.readUInt32LE(21)
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1, type: 'image/webp' }
    }
    return null
  }

  // JPEG: 扫 SOF 段
  if (buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) { offset++; continue }
      const marker = buffer[offset + 1]
      // SOF0-SOF15，排除 DHT(C4) / JPG(C8) / DAC(CC)
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return {
          height: buffer.readUInt16BE(offset + 5),
          width: buffer.readUInt16BE(offset + 7),
          type: 'image/jpeg',
        }
      }
      const segmentLength = buffer.readUInt16BE(offset + 2)
      if (segmentLength <= 0) break
      offset += 2 + segmentLength
    }
  }

  return null
}

/**
 * 下载图片并转成 data URL，超限直接放弃（不缩放，避免引入图像处理依赖）。
 * @param {string} url
 * @returns {Promise<{dataUrl: string, mimeType: string, bytes: number}|null>}
 */
export async function fetchImageAsDataUrl (url) {
  if (!url || typeof url !== 'string') return null
  const cached = IMAGE_CACHE.get(url)
  if (cached) return cached

  const maxBytes = Math.max(64 * 1024, Number(config.vision.maxImageSize) || 1048576)
  const maxDimension = Math.min(8000, Math.max(1, Number(config.vision.maxImageDimension) || 2000))

  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 15000)
    const response = await fetch(url, { signal: controller.signal })
    clearTimeout(timer)

    if (!response.ok) {
      globalThis.logger?.debug?.(`[bym][image] 下载失败 ${response.status}: ${url.slice(0, 80)}`)
      return null
    }

    const arrayBuffer = await response.arrayBuffer()
    const buffer = Buffer.from(arrayBuffer)
    // base64 会比原始字节大 1/3，按编码后的体积判断更有意义
    if (buffer.length * 1.34 > maxBytes) {
      globalThis.logger?.debug?.(`[bym][image] 图片过大（${Math.round(buffer.length / 1024)} KiB），跳过`)
      return null
    }

    const size = sniffImageSize(buffer)
    if (size && (size.width > maxDimension || size.height > maxDimension)) {
      globalThis.logger?.debug?.(`[bym][image] 图片尺寸 ${size.width}x${size.height} 超过上限 ${maxDimension}，跳过`)
      return null
    }

    const mimeType = size?.type || (response.headers.get('content-type') || 'image/jpeg').split(';')[0]
    const value = {
      dataUrl: `data:${mimeType};base64,${buffer.toString('base64')}`,
      mimeType,
      bytes: buffer.length,
    }
    rememberImage(url, value)
    return value
  } catch (err) {
    globalThis.logger?.debug?.(`[bym][image] 下载异常：${err.message}`)
    return null
  }
}

/** 批量下载，带数量上限，失败的项目被过滤掉而不是让整轮失败 */
export async function fetchImages (urls) {
  const limit = Math.max(0, Number(config.vision.maxImages) || 0)
  if (limit === 0) return []
  const unique = [...new Set((urls || []).filter(Boolean))].slice(0, limit)
  const results = await Promise.allSettled(unique.map(url => fetchImageAsDataUrl(url)))
  return results
    .filter(item => item.status === 'fulfilled' && item.value)
    .map(item => item.value)
}
