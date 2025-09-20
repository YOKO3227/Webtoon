/**
 * 청크 단위로 처리함
 */
function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const len = bytes.length;
  const CHUNK_SIZE = 0x8000; // 32KB chunks
  const chunks = [];
  
  for (let i = 0; i < len; i += CHUNK_SIZE) {
    const chunk = bytes.subarray(i, Math.min(i + CHUNK_SIZE, len));
    chunks.push(String.fromCharCode.apply(null, chunk));
  }
  
  return btoa(chunks.join(''));
}

/**
 * HTML 이스케이프
 */
const escapeHtml = (text) => {
  const htmlEscapes = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;'
  };
  return text.replace(/[&<>]/g, char => htmlEscapes[char]);
};

/**
 * 텍스트 스타일
 */
function createTextStyle(style, customFontName) {
  const {
    fontFamily = 'sans-serif',
    fontSize = 24,
    fill = '#000000',
    textAlign = 'left',
    lineHeight = 1.2,
    whiteSpace = 'pre-wrap',
    strokeWidth = 0,
    stroke = '#ffffff',
    useR2Font
  } = style;

  // 폰트 패밀리
  const actualFontFamily = (customFontName && useR2Font) 
    ? `'${customFontName}', ${fontFamily}` 
    : fontFamily;

  // 기본 CSS 속성 (문자열 템플릿)
  let cssString = `margin:0;padding:0;font-family:${actualFontFamily};font-size:${fontSize}px;color:${fill};text-align:${textAlign};line-height:${lineHeight};white-space:${whiteSpace};word-wrap:break-word;-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale`;

  // stroke가 있을 때만 추가
  if (strokeWidth > 0) {
    cssString += `;text-shadow:-${strokeWidth}px -${strokeWidth}px 0 ${stroke},${strokeWidth}px -${strokeWidth}px 0 ${stroke},-${strokeWidth}px ${strokeWidth}px 0 ${stroke},${strokeWidth}px ${strokeWidth}px 0 ${stroke}`;
  }

  return cssString;
}

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      const pathParts = url.pathname.split('/').filter(Boolean);
      
      if (pathParts.length < 3) {
        return new Response('URL 형식이 올바르지 않습니다: /버킷명/프로젝트폴더/.../파일명', { status: 400 });
      }

      const bucketName = pathParts[0];
      const projectFolder = pathParts[1];
      const imagePath = pathParts.slice(1).join('/');

      // 버킷 찾기 최적화
      let bucket = env[bucketName] || 
                   env[bucketName.toUpperCase().replace(/-/g, '_')] || 
                   env[bucketName.toLowerCase().replace(/-/g, '_')];
      
      if (!bucket) {
        return new Response(`R2 버킷 바인딩 '${bucketName}'을(를) 찾을 수 없습니다.`, { status: 500 });
      }

      // config와 image 가져오기(병렬)
      const configKey = `${projectFolder}/${projectFolder}.json`;
      const [configObject, imageObject] = await Promise.all([
        bucket.get(configKey),
        bucket.get(imagePath)
      ]);

      if (!configObject) {
        return new Response(`설정 파일(${configKey})을 찾을 수 없습니다.`, { status: 404 });
      }
      if (!imageObject) {
        return new Response(`배경 이미지(${imagePath})를 찾을 수 없습니다.`, { status: 404 });
      }

      // config 파싱과 이미지 버퍼 가져오기(병렬)
      const [config, imageBuffer] = await Promise.all([
        configObject.json(),
        imageObject.arrayBuffer()
      ]);

      const { 
        imageSize = {}, 
        elements = [], 
        defaultStyle = {}, 
        fonts = [], 
        fontSettings = {} 
      } = config;
      
      const width = imageSize.width || 800;
      const height = imageSize.height || 600;

      // 이미지 타입 결정
      let imageType = imageObject.httpMetadata?.contentType;
      if (!imageType) {
        const ext = imagePath.substring(imagePath.lastIndexOf('.') + 1).toLowerCase();
        imageType = {
          'png': 'image/png',
          'webp': 'image/webp',
          'jpg': 'image/jpeg',
          'jpeg': 'image/jpeg',
          'gif': 'image/gif',
          'svg': 'image/svg+xml'
        }[ext] || 'application/octet-stream';
      }

      // Base64 변환 (함수 변경했음)
      const base64ImageHref = `data:${imageType};base64,${arrayBufferToBase64(imageBuffer)}`;

      // 폰트 처리
      let fontStyles = '';
      let customFontName = null;
      const fontFaces = [];

      // R2 폰트 처리
      if (fontSettings.mode === 'r2' && fontSettings.r2FontFilename) {
        const fontKey = `${projectFolder}/fonts/${fontSettings.r2FontFilename}`;
        const fontObject = await bucket.get(fontKey);
        
        if (fontObject) {
          const fontBuffer = await fontObject.arrayBuffer();
          const fontBase64 = arrayBufferToBase64(fontBuffer);
          const ext = fontSettings.r2FontFilename.substring(fontSettings.r2FontFilename.lastIndexOf('.') + 1).toLowerCase();
          
          customFontName = 'CustomR2Font';
          const fontInfo = {
            'woff2': { mime: 'font/woff2', format: 'woff2' },
            'woff': { mime: 'font/woff', format: 'woff' },
            'ttf': { mime: 'font/ttf', format: 'truetype' },
            'otf': { mime: 'font/otf', format: 'opentype' }
          }[ext] || { mime: 'font/ttf', format: 'truetype' };
          
          fontFaces.push(`@font-face{font-family:'${customFontName}';src:url('data:${fontInfo.mime};charset=utf-8;base64,${fontBase64}')format('${fontInfo.format}');font-display:block}`);
        }
      }

      // 외부 폰트 처리
      if (fonts?.length > 0) {
        fonts.forEach(fontUrl => fontFaces.push(`@import url('${fontUrl}');`));
      }

      fontStyles = fontFaces.join('');

      // 텍스트 요소 처리
      const searchParams = url.searchParams;
      const textElements = elements
        .filter(el => el?.query && searchParams.has(el.query))
        .map(element => {
          const style = { ...defaultStyle, ...element.style };
          if (element.useR2Font) style.useR2Font = true;

          // 텍스트 처리
          let text = decodeURIComponent(searchParams.get(element.query) || '');
          text = text.replace(/_/g, ' ').replace(/%0A/gi, '\n');
          text = escapeHtml(text);
          const processedText = text.replace(/\n/g, '<br/>');

          const { 
            x = 0, 
            y = 0, 
            width: w = 100, 
            height: h = 100, 
            verticalAlign = 'top' 
          } = style;
          
          const alignItems = verticalAlign === 'middle' ? 'center' : 
                            verticalAlign === 'bottom' ? 'flex-end' : 'flex-start';
          
          const textStyle = createTextStyle(style, customFontName);

          return `<div style="position:absolute;left:${x}px;top:${y}px;width:${w}px;height:${h}px;display:flex;align-items:${alignItems};z-index:2"><div style="${textStyle};width:100%">${processedText}</div></div>`;
        }).join('');

      // 응답 타입 결정
      const isAnimated = imageType === 'image/gif' || imageType === 'image/webp';
      const formatParam = searchParams.get('format');

      if (isAnimated && formatParam !== 'svg') {
        // HTML 응답 (공백 제거)
        const htmlContent = `<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><style>${fontStyles}*{margin:0;padding:0;box-sizing:border-box}body{margin:0;padding:0;overflow:hidden}.container{position:relative;width:${width}px;height:${height}px;overflow:hidden}.background-image{position:absolute;top:0;left:0;width:100%;height:100%;z-index:1}</style></head><body><div class="container"><img src="${base64ImageHref}" class="background-image"/>${textElements}</div></body></html>`;

        return new Response(htmlContent, {
          headers: { 
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'public, max-age=31536000, immutable'
          }
        });
      } else {
        // SVG 응답 (공백 제거)
        const svgImage = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg"><defs><style type="text/css">${fontStyles}</style></defs><image href="${base64ImageHref}" width="${width}" height="${height}"/><foreignObject width="100%" height="100%"><div xmlns="http://www.w3.org/1999/xhtml" style="position:relative;width:${width}px;height:${height}px">${textElements}</div></foreignObject></svg>`;

        return new Response(svgImage, {
          headers: { 
            'Content-Type': 'image/svg+xml; charset=utf-8',
            'Cache-Control': 'public, max-age=31536000, immutable'
          }
        });
      }

    } catch (e) {
      return new Response(`Error: ${e.message}\nStack: ${e.stack}`, { status: 500 });
    }
  },
};
