import { describe, expect, it } from "vitest";
import { isAllowedAddress, isLocalHost } from "../address";

describe("isLocalHost", () => {
  it("accepts this computer and the private ranges", () => {
    for (const url of [
      "http://localhost:11434",
      "http://LOCALHOST",
      "http://ollama.localhost:8080/v1",
      "http://127.0.0.1:1234",
      "http://127.5.0.1",
      "http://[::1]:11434",
      "http://10.1.2.3",
      "http://172.16.0.1",
      "http://172.31.255.255",
      "http://192.168.1.5:11434",
      "https://192.168.1.5",
    ]) {
      expect(isLocalHost(url), url).toBe(true);
    }
  });

  it("refuses everything else", () => {
    for (const url of [
      "https://api.example.com",
      "http://172.15.0.1",
      "http://172.32.0.1",
      "http://192.169.0.1",
      "http://11.0.0.1",
      "http://localhost.example.com",
      "not a url",
      "",
    ]) {
      expect(isLocalHost(url), url).toBe(false);
    }
  });
});

describe("isAllowedAddress", () => {
  it("needs https unless the address is local", () => {
    expect(isAllowedAddress("https://api.example.com/v1")).toBe(true);
    expect(isAllowedAddress("http://localhost:11434")).toBe(true);
    expect(isAllowedAddress("http://192.168.0.2:1234")).toBe(true);
    expect(isAllowedAddress("http://api.example.com")).toBe(false);
    expect(isAllowedAddress("ftp://localhost")).toBe(false);
    expect(isAllowedAddress("example.com")).toBe(false);
  });

  it("allows an empty address (the provider default is used)", () => {
    expect(isAllowedAddress("")).toBe(true);
    expect(isAllowedAddress("   ")).toBe(true);
  });
});
