import { describe, it, expect } from "bun:test";
import {
  parseGitmodulesContent,
  type SubmoduleEntry,
} from "../src/core/gitmodules-parser";

describe("parseGitmodulesContent", () => {
  it("解析单个子模块 + branch", () => {
    const input = `[submodule "reverse-bot-rs"]
\tpath = reverse-bot-rs
\turl = https://github.com/ReverseGame/reverse-bot-rs.git
\tbranch = master
`;
    const result = parseGitmodulesContent(input);
    expect(result).toEqual([
      {
        name: "reverse-bot-rs",
        path: "reverse-bot-rs",
        url: "https://github.com/ReverseGame/reverse-bot-rs.git",
        branch: "master",
      },
    ]);
  });

  it("解析多个子模块（无 branch）", () => {
    const input = `[submodule "lib1"]
\tpath = vendor/lib1
\turl = git@github.com:foo/lib1.git
[submodule "lib2"]
\tpath = vendor/lib2
\turl = https://github.com/foo/lib2
`;
    const result = parseGitmodulesContent(input);
    expect(result.length).toBe(2);
    expect(result[0].name).toBe("lib1");
    expect(result[0].path).toBe("vendor/lib1");
    expect(result[0].branch).toBeNull();
    expect(result[1].name).toBe("lib2");
    expect(result[1].url).toBe("https://github.com/foo/lib2");
  });

  it("空文件返回空数组", () => {
    expect(parseGitmodulesContent("")).toEqual([]);
  });

  it("拒绝路径含 .. 的子模块", () => {
    const input = `[submodule "evil"]
\tpath = ../../../etc
\turl = https://github.com/x/y.git
`;
    expect(parseGitmodulesContent(input)).toEqual([]);
  });

  it("拒绝路径以 / 开头的子模块", () => {
    const input = `[submodule "abs"]
\tpath = /etc
\turl = https://github.com/x/y.git
`;
    expect(parseGitmodulesContent(input)).toEqual([]);
  });

  it("忽略缺 path 或 url 的不完整段", () => {
    const input = `[submodule "bad"]
\tpath = vendor/bad
[submodule "good"]
\tpath = vendor/good
\turl = https://github.com/x/good.git
`;
    const result = parseGitmodulesContent(input);
    expect(result.length).toBe(1);
    expect(result[0].name).toBe("good");
  });

  it("空白容忍：tab / 多空格 / 末尾换行不影响", () => {
    const input = `[submodule "x"]
    path = vendor/x
        url   =   https://github.com/o/x.git\n\n`;
    const result = parseGitmodulesContent(input);
    expect(result.length).toBe(1);
    expect(result[0].path).toBe("vendor/x");
  });

  it("忽略注释行（# 和 ;）", () => {
    const input = `# 这是注释
[submodule "x"]
\tpath = x
\turl = https://github.com/o/x.git
; 另一种注释
`;
    const result = parseGitmodulesContent(input);
    expect(result.length).toBe(1);
    expect(result[0].name).toBe("x");
  });
});
