import type { GoogleClient } from './auth'

/**
 * The app's OAuth client from Google Cloud ("Desktop app" type). For installed apps Google does not
 * treat the client secret as a secret: it ships inside the app, and PKCE protects each sign-in.
 * APV_GOOGLE_CLIENT_ID / APV_GOOGLE_CLIENT_SECRET override these for testing.
 */
export const GOOGLE_CLIENT: GoogleClient = {
  clientId: process.env.APV_GOOGLE_CLIENT_ID || '',
  clientSecret: process.env.APV_GOOGLE_CLIENT_SECRET || ''
}
