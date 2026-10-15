/* ==========================================================================
 * proto-tool · 桌面端 Rust 侧
 * --------------------------------------------------------------------------
 * 职责边界：**只做文件 IO**。
 *
 * 注入逻辑（剥离旧标记 / 构造数据块 / 插入运行时）刻意不在这里用 Rust 重写，
 * 而是复用前端加载的 src/lib/injector.js。原因很简单：那份文件同时被
 * Node 本地服务使用，两处各写一份实现必然漂移，最后两边存出来的文件不一样。
 *
 * 之所以能这么分工，是因为桌面端与 Rust 之间只传字符串，
 * 而单文件原型通常只有几十 KB，走 IPC 没有任何压力。
 * ========================================================================== */

use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

/* --------------------------------------------------------------- 数据结构 */

#[derive(Serialize)]
pub struct Entry {
    name: String,
    path: String,
    is_dir: bool,
    size: u64,
    /// 前端据此区分渲染样式：drive（盘符）/ quick（快捷入口）/ dir / file
    kind: String,
}

#[derive(Serialize)]
pub struct Listing {
    dir: String,
    parent: Option<String>,
    dirs: Vec<Entry>,
    files: Vec<Entry>,
}

#[derive(Serialize)]
pub struct Stat {
    path: String,
    size: u64,
    modified: u64,
}

/* --------------------------------------------------------------- 工具函数 */

/// 判据与服务端 server/index.js 的 assertHtml 保持一致：只认 .html / .htm
fn is_html(p: &Path) -> bool {
    match p.extension().and_then(|s| s.to_str()) {
        Some(ext) => {
            let e = ext.to_ascii_lowercase();
            e == "html" || e == "htm"
        }
        None => false,
    }
}

fn file_entry(p: &Path) -> Option<Entry> {
    let name = p.file_name()?.to_string_lossy().to_string();
    // 跳过隐藏文件与 Office 临时文件（~$ 开头），与服务端行为一致
    if name.starts_with('.') || name.starts_with("~$") {
        return None;
    }
    let is_dir = p.is_dir();
    Some(Entry {
        name,
        path: p.to_string_lossy().to_string(),
        is_dir,
        size: if is_dir {
            0
        } else {
            fs::metadata(p).map(|m| m.len()).unwrap_or(0)
        },
        kind: if is_dir { "dir" } else { "file" }.to_string(),
    })
}

fn sort_by_name(v: &mut [Entry]) {
    v.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
        .filter(|p| p.is_dir())
}

/// 快捷入口：桌面 / 下载 / 文档。找不到就跳过，不报错。
fn quick_dirs() -> Vec<Entry> {
    let mut out = Vec::new();
    if let Some(home) = home_dir() {
        for (label, sub) in [
            ("桌面", "Desktop"),
            ("下载", "Downloads"),
            ("文档", "Documents"),
        ] {
            let p = home.join(sub);
            if p.is_dir() {
                out.push(Entry {
                    name: label.to_string(),
                    path: p.to_string_lossy().to_string(),
                    is_dir: true,
                    size: 0,
                    kind: "quick".to_string(),
                });
            }
        }
    }
    out
}

/* ------------------------------------------------------------------- 指令 */

/// 列出可用根：Windows 为盘符，*nix 为 /
#[tauri::command]
fn list_roots() -> Vec<Entry> {
    let mut out = Vec::new();

    #[cfg(windows)]
    {
        for c in b'A'..=b'Z' {
            let root = format!("{}:\\", c as char);
            if Path::new(&root).exists() {
                out.push(Entry {
                    name: format!("{}:", c as char),
                    path: root,
                    is_dir: true,
                    size: 0,
                    kind: "drive".to_string(),
                });
            }
        }
    }

    #[cfg(not(windows))]
    {
        out.push(Entry {
            name: "/".to_string(),
            path: "/".to_string(),
            is_dir: true,
            size: 0,
            kind: "drive".to_string(),
        });
    }

    out
}

/// 列目录。dir 为空时返回"根视图"（快捷入口 + 盘符），
/// 语义与服务端的 /api/browse 完全一致，前端不用改判断逻辑。
#[tauri::command]
fn list_dir(dir: String) -> Result<Listing, String> {
    if dir.trim().is_empty() {
        let mut dirs = quick_dirs();
        dirs.extend(list_roots());
        return Ok(Listing {
            dir: String::new(),
            parent: None,
            dirs,
            files: Vec::new(),
        });
    }

    let base = PathBuf::from(&dir);
    let rd = fs::read_dir(&base).map_err(|e| format!("无法读取目录 {}：{}", dir, e))?;

    let mut dirs = Vec::new();
    let mut files = Vec::new();
    for ent in rd.flatten() {
        let p = ent.path();
        if let Some(e) = file_entry(&p) {
            if e.is_dir {
                dirs.push(e);
            } else if is_html(&p) {
                files.push(e);
            }
        }
    }
    sort_by_name(&mut dirs);
    sort_by_name(&mut files);

    Ok(Listing {
        dir: base.to_string_lossy().to_string(),
        parent: base.parent().map(|p| p.to_string_lossy().to_string()),
        dirs,
        files,
    })
}

/// 读一个文本文件（HTML 原型本体）
#[tauri::command]
fn read_text_file(path: String) -> Result<String, String> {
    fs::read_to_string(&path).map_err(|e| format!("读取失败 {}：{}", path, e))
}

/// 原子写：先写同目录的 .an-tmp，再 rename 覆盖。
/// 中途崩溃最坏只留下一个临时文件，原文件不会被写坏。
#[tauri::command]
fn write_text_file(path: String, content: String) -> Result<(), String> {
    let target = PathBuf::from(&path);
    if !is_html(&target) {
        return Err(format!("拒绝写入非 HTML 文件：{}", path));
    }

    let tmp = PathBuf::from(format!("{}.an-tmp", path));
    fs::write(&tmp, content.as_bytes()).map_err(|e| format!("写入临时文件失败：{}", e))?;
    fs::rename(&tmp, &target).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("替换目标文件失败：{}", e)
    })
}

/// 文件信息：大小 + 修改时间（毫秒时间戳）
#[tauri::command]
fn stat_file(path: String) -> Result<Stat, String> {
    let md = fs::metadata(&path).map_err(|e| format!("无法读取文件信息 {}：{}", path, e))?;
    let modified = md
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);

    Ok(Stat {
        path,
        size: md.len(),
        modified,
    })
}

/// 渲染运行时的源码在**编译期内嵌**，运行时不再依赖磁盘上的 js 文件。
/// 好处：安装包里不会出现一个可被误删/篡改的松散脚本。
#[tauri::command]
fn read_runtime() -> String {
    include_str!("../../src/runtime/annotator.js").to_string()
}

/* ------------------------------------------------------------------ 启动 */

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            list_roots,
            list_dir,
            read_text_file,
            write_text_file,
            stat_file,
            read_runtime,
        ])
        .run(tauri::generate_context!())
        .expect("启动 proto-tool 桌面端失败");
}
