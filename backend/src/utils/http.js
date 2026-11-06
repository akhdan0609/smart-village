function sendOk(res, data, status = 200) {
  return res.status(status).json({ success: true, data });
}

function sendError(res, message, status = 400, details) {
  return res.status(status).json({
    success: false,
    error: message,
    ...(details ? { details } : {})
  });
}

module.exports = { sendOk, sendError };
