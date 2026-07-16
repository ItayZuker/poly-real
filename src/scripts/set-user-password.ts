/**
 * Set (or bootstrap) a login password for a user in the users collection.
 *
 * Usage:
 *   npx tsx src/scripts/set-user-password.ts <email> <password>
 *
 * If no user has that email, assigns the email + password to the default slug user.
 */
import "dotenv/config";
import { ensureDefaultUser, setUserPasswordByEmail } from "../db/user-repository.js";
import { closeMongoClient } from "../db/mongo-client.js";

async function main(): Promise<void> {
  const email = process.argv[2]?.trim();
  const password = process.argv[3];
  if (!email || password == null || password === "") {
    console.error("Usage: npx tsx src/scripts/set-user-password.ts <email> <password>");
    process.exit(1);
  }
  if (password.length < 6) {
    console.error("Password must be at least 6 characters");
    process.exit(1);
  }

  await ensureDefaultUser();
  const user = await setUserPasswordByEmail(email, password);
  console.log(`Password set for user "${user.email}" (id=${user.id}, slug=${user.slug})`);
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  })
  .finally(async () => {
    await closeMongoClient().catch(() => {});
  });
