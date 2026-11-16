import { describe, expect, it } from "vitest";
import { rpcSummary } from "../src/rpc-summary";

describe("rpcSummary", () => {
  it("names methods and tools without arguments", () => {
    expect(rpcSummary('{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"okf_search","arguments":{"query":"secret stuff"}}}')).toBe("tools/call:okf_search");
    expect(rpcSummary('[{"method":"initialize"},{"method":"tools/list"}]')).toBe("initialize,tools/list");
    expect(rpcSummary("not json")).toBe("unparsed");
  });
});
