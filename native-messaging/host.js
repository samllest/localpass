const http = require('http')

// 标准的 Native Messaging 通信协议：
// 长度前缀：前四个字节以系统原生字节序发送消息的长度（本系统为整数长度为4字节，little-endian）。
function sendMessage(msg) {
  const buf = Buffer.from(JSON.stringify(msg))
  const header = Buffer.alloc(4)
  header.writeUInt32LE(buf.length, 0)
  process.stdout.write(header)
  process.stdout.write(buf)
}

process.stdin.on('readable', () => {
  let chunk
  while ((chunk = process.stdin.read()) !== null) {
    if (chunk.length >= 4) {
      const msgLen = chunk.readUInt32LE(0)
      if (chunk.length >= 4 + msgLen) {
        const payloadStr = chunk.slice(4, 4 + msgLen).toString('utf8')
        
        try {
          // Send to LocalPass GUI internal bridge
          const req = http.request({
            hostname: '127.0.0.1',
            port: 35320,
            path: '/capture',
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(payloadStr)
            }
          }, (res) => {
             res.on('data', () => {});
             res.on('end', () => {
               sendMessage({ status: "ok", code: res.statusCode })
             })
          });
          
          req.on('error', (e) => {
             // 可能是 GUI 没开或者没解锁
             sendMessage({ status: "error", error: "GUI not available or locked" })
          });
          
          req.write(payloadStr);
          req.end();

        } catch (e) {
          sendMessage({ error: e.toString() })
        }
      }
    }
  }
})
