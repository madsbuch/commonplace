import { describe, expect, test } from "bun:test";
import { newId, parseTypeId, prefixOf, typeIdOf } from "../src/lib/ids";
import { dbId, editorId } from "../src/blocks/ids";

// The TypeID spec's own examples (typeid/spec/valid.yml).
const SPEC: [string, string][] = [
  ["00000000-0000-0000-0000-000000000000", "00000000000000000000000000"],
  ["00000000-0000-0000-0000-000000000001", "00000000000000000000000001"],
  ["00000000-0000-0000-0000-00000000000a", "0000000000000000000000000a"],
  ["00000000-0000-0000-0000-000000000010", "0000000000000000000000000g"],
  ["00000000-0000-0000-0000-000000000020", "00000000000000000000000010"],
  ["ffffffff-ffff-ffff-ffff-ffffffffffff", "7zzzzzzzzzzzzzzzzzzzzzzzzz"],
  ["01890a5d-ac96-774b-bcce-b302099a8057", "01h455vb4pex5vsknk084sn02q"],
];

describe("row ids", () => {
  // Spec: ID-1
  test("spell a UUID the way the TypeID spec does, and read back", () => {
    for (const [uuid, suffix] of SPEC) {
      expect(typeIdOf("blk", uuid)).toBe(`blk_${suffix}`);
      expect(parseTypeId(`blk_${suffix}`)).toEqual({ prefix: "blk", uuid });
    }
  });

  test("carry their table's prefix, and sort in the order they were made", () => {
    expect(prefixOf(newId("blocks"))).toBe("blk");
    expect(prefixOf(newId("revisions"))).toBe("rev");
    expect(parseTypeId("user_01h455vb4pex5vsknk084sn02q")).toBeNull();
    const ids = Array.from({ length: 2000 }, () => newId("revisions"));
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
  });

  // Spec: ID-1
  test("an editor block's id and its row's id are the same 128 bits", () => {
    const uuid = "6f1c1e43-5d6e-4b8a-9f00-0123456789ab";
    const id = dbId(uuid);
    expect(id.startsWith("blk_")).toBe(true);
    expect(editorId(id)).toBe(uuid);
    const made = newId("blocks");
    expect(dbId(editorId(made))).toBe(made);
  });
});
