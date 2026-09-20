import { convexAuth } from "@convex-dev/auth/server";
import { Password } from "@convex-dev/auth/providers/Password";

export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  providers: [
    Password({
      profile(params) {
        const email = (params.email as string | undefined) ?? "";
        const name = (params.name as string | undefined) ?? "";
        const phone = params.phone as string | undefined;
        return {
          email: email.trim().toLowerCase(),
          name,
          ...(phone ? { phone } : {}),
        };
      },
    }),
  ],
});
