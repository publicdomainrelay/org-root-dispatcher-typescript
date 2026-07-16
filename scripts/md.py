#!/usr/bin/env -S python -m uv run
# /// script
# requires-python = ">=3.8"
# dependencies = [
#     "beautifulsoup4==v4.14.3",
#     "lxml==v6.1.1",
#     "markdown==v3.7",
#     "pygments==v2.19.2",
# ]
# ///

import base64
import mimetypes
import os
import re
import sys
import textwrap
import socket
import threading
import webbrowser
from http.server import BaseHTTPRequestHandler, HTTPServer

import markdown
from bs4 import BeautifulSoup
from pygments.formatters import HtmlFormatter


def bootstrapify_html(html_string: str, base_dir: str = None) -> str:
    soup = BeautifulSoup(html_string, "lxml")

    body = soup.find("body")
    if not body:
        body = soup

    container = soup.new_tag("div", attrs={"class": "container py-4"})

    original_content = body.find_all(recursive=False)
    for element in original_content:
        container.append(element.extract())
    body.append(container)

    h1 = soup.find("h1")
    if h1:
        h1["class"] = "display-5"

    for h2 in soup.find_all("h2"):
        h2["class"] = "mt-5"
        h2["id"] = h2.get_text(strip=True).lower().replace(" ", "-")

    for h3 in soup.find_all("h3"):
        h3["id"] = h3.get_text(strip=True).lower().replace(" ", "-")

    for h4 in soup.find_all("h4"):
        h4["class"] = "mt-4"

    for img in soup.find_all("img"):
        img["class"] = "img-fluid"
        src = img.get("src", "")
        if src and not src.startswith("data:") and not src.startswith("http://") and not src.startswith("https://"):
            img_path = os.path.join(base_dir, src) if base_dir else src
            if os.path.isfile(img_path):
                mime, _ = mimetypes.guess_type(img_path)
                if not mime:
                    mime = "image/png"
                with open(img_path, "rb") as f:
                    data = base64.b64encode(f.read()).decode("ascii")
                img["src"] = f"data:{mime};base64,{data}"

    for span in soup.find_all("span", class_="err"):
        span["class"].remove("err")

    for div in soup.find_all("div", class_="codehilite"):
        pre_tag = div.find("pre")
        if pre_tag:
            pre_tag["class"] = "codehilite bg-light p-3 rounded-3"
        div.unwrap()

    for table in soup.find_all("table"):
        table["class"] = "table table-bordered table-sm"

    ASCIINEMA_RE = re.compile(r'^https://asciinema\.org/a/([a-zA-Z0-9]+)$')

    for a_tag in soup.find_all("a", href=True):
        href = a_tag.get("href", "")
        m = ASCIINEMA_RE.match(href)
        if not m:
            continue
        rec_id = m.group(1)
        img = a_tag.find("img")
        if not img:
            continue
        img_src = img.get("src", "")
        if not img_src.startswith(f"https://asciinema.org/a/{rec_id}."):
            continue

        script_tag = soup.new_tag("script",
            src=f"https://asciinema.org/a/{rec_id}.js",
            id=f"asciicast-{rec_id}")
        script_tag["async"] = ""

        parent = a_tag.parent
        if parent and parent.name == "p":
            parent.replace_with(script_tag)
        else:
            a_tag.replace_with(script_tag)

    CALLOUTS = {
        "[!NOTE]":      {"class": "alert-primary",      "icon": "ℹ️", "label": "Note"},
        "[!TIP]":       {"class": "alert-success",      "icon": "💡", "label": "Tip"},
        "[!IMPORTANT]": {"class": "alert-important",    "icon": "💬", "label": "Important"},
        "[!WARNING]":   {"class": "alert-warning",      "icon": "⚠️", "label": "Warning"},
        "[!CAUTION]":   {"class": "alert-danger",       "icon": "❗", "label": "Caution"},
    }

    for bq in soup.find_all("blockquote"):
        # Group children into callout segments (each headed by a [!MARKER] <p>)
        callout_groups = []
        current_group = None

        for child in list(bq.children):
            if child.name == "p":
                child_text = child.get_text(strip=True)
                matched_marker = None
                matched_cfg = None
                for marker, cfg in CALLOUTS.items():
                    if child_text.startswith(marker):
                        matched_marker = marker
                        matched_cfg = cfg
                        break
                if matched_marker:
                    if current_group:
                        callout_groups.append(current_group)
                    current_group = (matched_marker, matched_cfg, [child])
                    continue
            if current_group is not None:
                current_group[2].append(child)

        if current_group:
            callout_groups.append(current_group)

        if callout_groups:
            prev = None
            for marker, cfg, children in callout_groups:
                callout_div = soup.new_tag("div", attrs={
                    "class": f"alert {cfg['class']} d-flex align-items-start my-3 callout-box",
                    "role": "alert",
                })

                icon_span = soup.new_tag("span", attrs={"class": "me-2 fs-5 callout-icon"})
                icon_span.string = cfg["icon"]
                callout_div.append(icon_span)

                body_div = soup.new_tag("div", attrs={"class": "callout-body"})
                strong_tag = soup.new_tag("strong")
                strong_tag.string = cfg["label"]
                body_div.append(strong_tag)

                for child in children:
                    if child.name == "p" and child.get_text(strip=True).startswith(marker):
                        remaining = child.get_text(strip=True)[len(marker):].lstrip()
                        if remaining:
                            p_tag = soup.new_tag("p", attrs={"class": "mb-1 mt-1"})
                            p_tag.string = remaining
                            body_div.append(p_tag)
                    else:
                        child_copy = child.__copy__() if callable(getattr(child, '__copy__', None)) else child
                        body_div.append(child_copy)

                callout_div.append(body_div)

                if prev is None:
                    bq.insert_before(callout_div)
                else:
                    prev.insert_after(callout_div)
                prev = callout_div

            bq.decompose()
        else:
            bq["class"] = "border-start border-3 border-secondary ps-3 text-muted my-4"

    soup = BeautifulSoup(soup.prettify(), "html.parser")

    new_link_tag = soup.new_tag(
        "link",
        href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css",
        rel="stylesheet",
        crossorigin="anonymous",
    )
    new_script_tag_mermaidjs = soup.new_tag(
        "script",
        type="module",
    )
    new_script_tag_mermaidjs.string = textwrap.dedent("""\
        import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs';
        mermaid.initialize({ startOnLoad: true, theme: 'default' });
    """)

    callout_style = soup.new_tag("style")
    callout_style.string = textwrap.dedent("""\
        .alert-important {
            --bs-alert-color: #6b21a8;
            --bs-alert-bg: #f3e8ff;
            --bs-alert-border-color: #d8b4fe;
        }
        .callout-box {
            border-left: 4px solid var(--bs-alert-border-color, currentColor) !important;
        }
    """)

    head = soup.find("head")
    if head:
        meta_charset = soup.new_tag("meta", charset="utf-8")
        head.insert(0, meta_charset)
        head.append(new_link_tag)
        head.append(callout_style)
        head.append(new_script_tag_mermaidjs)

    return str(soup)


def replace_mermaid_blocks(text: str) -> str:
    pattern = re.compile(r'^```mermaid\n(.*?)\n^```$', re.DOTALL | re.MULTILINE)
    replacement = r'<pre class="mermaid">\1</pre>'
    return pattern.sub(replacement, text)


def convert_markdown_to_html(markdown_text: str, base_dir: str = None) -> str:
    markdown_text = replace_mermaid_blocks(markdown_text)

    html_content = markdown.markdown(
        markdown_text,
        extensions=["fenced_code", "codehilite", "tables"],
    )

    formatter = HtmlFormatter(style="default", full=True, cssclass="codehilite")
    css_styles = formatter.get_style_defs(".codehilite")

    styled_html = f"<style>{css_styles}</style>\n{html_content}"
    return bootstrapify_html(styled_html, base_dir=base_dir)


def make_handler(html_content: str):
    class MarkdownHTMLHandler(BaseHTTPRequestHandler):
        def do_GET(self):
            if self.path == "/":
                self.send_response(200)
                self.send_header("Content-type", "text/html; charset=utf-8")
                self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
                self.send_header("Pragma", "no-cache")
                self.send_header("Expires", "0")
                self.end_headers()
                self.wfile.write(html_content.encode("utf-8"))
            else:
                self.send_error(404, "Not Found")

        def log_message(self, format, *args):
            pass

    return MarkdownHTMLHandler


def main():
    import argparse

    parser = argparse.ArgumentParser(description="Render Markdown as styled HTML")
    parser.add_argument("file", nargs="?", help="Markdown file (default: stdin)")
    parser.add_argument("-o", "--output", metavar="FILE", help="Write HTML to file instead of opening browser")
    args = parser.parse_args()

    base_dir = None

    if args.file:
        base_dir = os.path.dirname(os.path.abspath(args.file))
        try:
            with open(args.file, "r", encoding="utf-8") as f:
                markdown_input = f.read()
        except OSError as e:
            print(f"Error reading file: {e}", file=sys.stderr)
            sys.exit(1)
    else:
        if sys.stdin.isatty():
            print("Reading markdown from standard input (Press Ctrl+D to submit on Unix, or Ctrl+Z on Windows)...", file=sys.stderr)
        try:
            markdown_input = sys.stdin.read()
        except KeyboardInterrupt:
            print("\nAborted.", file=sys.stderr)
            sys.exit(1)

    html_output = convert_markdown_to_html(markdown_input, base_dir=base_dir)

    if args.output:
        try:
            with open(args.output, "w", encoding="utf-8") as f:
                f.write(html_output)
            print(f"Written to {args.output}", file=sys.stderr)
        except OSError as e:
            print(f"Error writing output: {e}", file=sys.stderr)
            sys.exit(1)
        return

    server_address = ("127.0.0.1", 0)
    handler_class = make_handler(html_output)

    try:
        httpd = HTTPServer(server_address, handler_class)
    except Exception as e:
        print(f"Failed to bind local server: {e}", file=sys.stderr)
        sys.exit(1)

    port = httpd.server_address[1]
    url = f"http://127.0.0.1:{port}"

    def open_browser():
        webbrowser.open(url)

    threading.Timer(0.5, open_browser).start()

    print(f"Serving at {url} (Ctrl+C to stop)", file=sys.stderr)

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping HTTP server...", file=sys.stderr)
        httpd.server_close()


if __name__ == "__main__":
    main()
