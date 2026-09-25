const request = {
  method: 'get',
  path: '/api/health',
  query: {},
  headers: {},
  body: null,
}

const response = {
  message: 'PopDownloader local API is running',
  author: 'jason',
  port: 3001,
  // 用于判断当前运行的是哪一版构建（排查「改了没生效」这类问题时很有用）
  build: '2026-09-fix2',
}

module.exports = {
  name: 'health',
  method: request.method,
  path: request.path,
  request,
  response,
  handler: (_req, res) => {
    res.json({
      message: response.message,
      author: response.author,
      port: process.env.PORT || response.port,
      build: response.build,
    })
  },
}
