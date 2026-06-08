const { onCall, HttpsError } = require('firebase-functions/v2/https')
const { defineSecret } = require('firebase-functions/params')
const { RtcTokenBuilder, RtcRole } = require('agora-token')

const AGORA_APP_CERTIFICATE = defineSecret('AGORA_APP_CERTIFICATE')

const AGORA_APP_ID = process.env.AGORA_APP_ID
const TOKEN_EXPIRY_SECONDS = 3600 // 1 hour

exports.getAgoraToken = onCall(
  { secrets: [AGORA_APP_CERTIFICATE] },
  (request) => {
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Must be logged in.')
    }
    const { channelName, uid } = request.data
    if (!channelName || uid == null) {
      throw new HttpsError('invalid-argument', 'channelName and uid are required.')
    }
    const certificate = AGORA_APP_CERTIFICATE.value()
    const expirationTime = Math.floor(Date.now() / 1000) + TOKEN_EXPIRY_SECONDS
    const token = RtcTokenBuilder.buildTokenWithUid(
      AGORA_APP_ID,
      certificate,
      channelName,
      uid,
      RtcRole.PUBLISHER,
      expirationTime,
      expirationTime
    )
    return { token }
  }
)
