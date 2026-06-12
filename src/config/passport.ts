import passport from 'passport';
import { Strategy as GoogleStrategy } from 'passport-google-oauth20';
import { User } from '../models/users';
import { XXSubscription } from '../models/xxsubscription';
import { xxGrantLoginProAccess } from '../modules/xxbilling/xxbilling.service';

const shouldHydrateNameFromGoogle = (currentName: string | undefined, email: string): boolean => {
  const normalized = String(currentName || '').trim().toLowerCase();
  const emailLocalPart = email.split('@')[0].toLowerCase();

  if (!normalized) return true;

  // Backfill display name when account still has common placeholders.
  const placeholderNames = new Set([
    'user',
    'username',
    'guest',
    'member',
    'new user',
    'newuser',
    'default user',
    'default',
  ]);

  if (placeholderNames.has(normalized)) return true;
  if (normalized === emailLocalPart) return true;

  return false;
};

const ensureInitialTrialAccess = async (userId: string) => {
  const hasAnySubscription = await XXSubscription.findOne({ userId }).lean();

  if (!hasAnySubscription) {
    await xxGrantLoginProAccess(userId);
  }
};

passport.use(
  new GoogleStrategy(
    {
      clientID:     process.env.GOOGLE_CLIENT_ID as string,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET as string,
      callbackURL:  process.env.GOOGLE_CALLBACK_URL as string,
    },
    async (_accessToken, _refreshToken, profile, done) => {
      try {
        const rawEmail = profile.emails?.[0]?.value;
        const email = rawEmail?.trim().toLowerCase();
        if (!email) {
          return done(new Error('No email returned from Google'), undefined);
        }

        const googleDisplayName = String(profile.displayName || '').trim() || email.split('@')[0];
        let shouldSaveUser = false;
        let createdFromGoogle = false;

        // 1. Try to find by googleId first
        let user = await User.findOne({ googleId: profile.id });

        if (!user) {
          // 2. Check if an email-based account already exists → link googleId on first Google login
          user = await User.findOne({ email });

          if (user) {
            user.googleId = profile.id;
            shouldSaveUser = true;

            if (user.emailVerified !== true) {
              user.emailVerified = true;
              user.emailVerificationTokenHash = undefined;
              user.emailVerificationExpiresAt = undefined;
              shouldSaveUser = true;
            }

            if (shouldHydrateNameFromGoogle(user.name, email)) {
              user.name = googleDisplayName;
              shouldSaveUser = true;
            }

            if (!user.image && profile.photos?.[0]?.value) {
              user.image = profile.photos[0].value;
              shouldSaveUser = true;
            }
          } else {
            // 3. First-time Google sign-in → create account
            user = await User.create({
              name: googleDisplayName,
              email,
              googleId: profile.id,
              image: profile.photos?.[0]?.value,
              emailVerified: true,
            });

            createdFromGoogle = true;
          }
        } else {
          if (shouldHydrateNameFromGoogle(user.name, email)) {
            user.name = googleDisplayName;
            shouldSaveUser = true;
          }

          if (!user.image && profile.photos?.[0]?.value) {
            user.image = profile.photos[0].value;
            shouldSaveUser = true;
          }
        }

        if (shouldSaveUser) {
          await user.save();
        }

        // Keep OAuth behavior aligned with email signup and auto-heal older OAuth-only accounts:
        // if no subscription document exists yet, grant the initial 7-day Pro trial exactly once.
        const isOAuthOnlyAccount = !!user.googleId && !user.passwordHash;
        if (createdFromGoogle || isOAuthOnlyAccount) {
          await ensureInitialTrialAccess(String(user._id));
        }

        if (!user.isActive) {
          return done(null, false as any);
        }

        return done(null, user);
      } catch (err) {
        return done(err as Error, undefined);
      }
    },
  ),
);

export default passport;
