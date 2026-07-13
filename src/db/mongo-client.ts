import { MongoClient } from "mongodb";

let client: MongoClient | null = null;
let connectPromise: Promise<MongoClient> | null = null;

function getMongoUri(): string {
  const uri = process.env.MONGODB_URI?.trim();
  if (!uri) {
    throw new Error("MONGODB_URI is not configured");
  }
  return uri;
}

export function getMongoDbName(): string {
  return process.env.MONGODB_DB?.trim() || "poly_recorder";
}

export async function getMongoClient(): Promise<MongoClient> {
  if (client) return client;
  if (!connectPromise) {
    connectPromise = MongoClient.connect(getMongoUri()).then((c) => {
      client = c;
      return c;
    });
  }
  return connectPromise;
}

export async function closeMongoClient(): Promise<void> {
  if (client) {
    await client.close();
    client = null;
    connectPromise = null;
  }
}
