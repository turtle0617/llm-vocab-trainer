export interface CardsCursor {
  due: string;
  createdAt: string;
  cardId: string;
}

export function encodeCursor(cursor: CardsCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeCursor(value: string): CardsCursor {
  const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<CardsCursor>;
  if (!parsed.due || !parsed.createdAt || !parsed.cardId) {
    throw new Error("Invalid cursor");
  }
  return {
    due: parsed.due,
    createdAt: parsed.createdAt,
    cardId: parsed.cardId
  };
}
