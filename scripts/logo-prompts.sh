#!/bin/bash
# Logo Prompt Generator - scans all repos and outputs AI image generation prompts
# Usage: bash scripts/logo-prompts.sh

APPS_API="http://localhost:9876/api/apps"

echo "========================================"
echo "  Logo Prompt Generator for Local Apps"
echo "========================================"
echo ""

# Fetch all apps from the monitor API
apps=$(curl -s "$APPS_API" 2>/dev/null)
if [ -z "$apps" ]; then
  echo "ERROR: Could not reach local-apps API at $APPS_API"
  exit 1
fi

# For each app, read package.json description and generate a prompt
echo "$apps" | python3 -c "
import sys, json, os

apps = json.load(sys.stdin)

# App metadata for prompt generation
meta = {
    'bheng': {
        'desc': 'Personal developer portfolio and blog',
        'style': 'minimalist monogram',
        'colors': 'black, white, electric blue',
        'symbol': 'the letter B stylized as a code bracket',
        'vibe': 'professional, clean, developer-focused'
    },
    'tools': {
        'desc': 'Collection of 30+ developer utility tools (JSON, PDF, QR, network)',
        'style': 'geometric toolbox',
        'colors': 'dark gray, multi-hue accents (each tool has its own hue)',
        'symbol': 'a Swiss Army knife or wrench made of pixels',
        'vibe': 'versatile, practical, colorful yet cohesive'
    },
    'diagrams': {
        'desc': 'Beautiful diagram generator with Mermaid syntax and real-time preview',
        'style': 'flowing connected nodes',
        'colors': 'deep purple (#8B5CF6), violet, white',
        'symbol': 'interconnected nodes forming a diamond or flowchart shape',
        'vibe': 'creative, technical, elegant'
    },
    'claude': {
        'desc': 'Dashboard GUI for Claude Code sessions, memory, and MCP servers',
        'style': 'hexagonal AI brain',
        'colors': 'warm sand (#D4A574), dark charcoal, white',
        'symbol': 'a hexagon (Claude logo shape) with dashboard grid inside',
        'vibe': 'intelligent, organized, AI-native'
    },
    'stickies': {
        'desc': 'Collaborative sticky notes board with markdown and real-time sync',
        'style': 'playful sticky note',
        'colors': 'bright yellow (#FFCC00), warm orange, dark text',
        'symbol': 'a folded sticky note with a subtle pin or sparkle',
        'vibe': 'fun, quick, tactile'
    },
    'mindmaps': {
        'desc': 'Visual mind mapping tool with tree and fishbone layouts',
        'style': 'organic branching tree',
        'colors': 'indigo (#6366F1), purple, soft white',
        'symbol': 'a central node with radiating branches like a neuron or tree',
        'vibe': 'creative, expansive, brainstorming'
    },
    'safe': {
        'desc': 'Local .env key/value manager with AI analysis',
        'style': 'vault/shield',
        'colors': 'dark steel gray, green accent (#22C55E), white',
        'symbol': 'a locked vault door or shield with a key slot',
        'vibe': 'secure, private, trustworthy'
    },
    'drop': {
        'desc': 'LAN file transfer - drop files between devices instantly',
        'style': 'motion/transfer arrows',
        'colors': 'green (#16A34A), teal, white',
        'symbol': 'a downward arrow or parachute dropping a file/package',
        'vibe': 'fast, effortless, instant'
    },
    'ai-spinner': {
        'desc': 'Electron menubar status indicator with WebSocket for AI activity',
        'style': 'spinning atom/loading',
        'colors': 'monokai pink (#F92672), yellow (#E6DB74), cyan (#66D9EF)',
        'symbol': 'an orbiting atom or pulsing spinner ring',
        'vibe': 'dynamic, alive, cyberpunk'
    },
    'moments': {
        'desc': 'Digital photo frame app for uploading and displaying photos',
        'style': 'camera aperture or photo frame',
        'colors': 'warm black, soft gold, white',
        'symbol': 'a camera aperture blending into a picture frame',
        'vibe': 'nostalgic, warm, personal'
    },
    'frames': {
        'desc': 'Device mockup generator - place screenshots into Apple device frames',
        'style': 'nested device outlines',
        'colors': 'dark (#0E0E10), silver, subtle blue',
        'symbol': 'overlapping device silhouettes (phone, laptop, tablet)',
        'vibe': 'sleek, product-focused, Apple-inspired'
    }
}

for app in apps:
    aid = app['id']
    name = app.get('name', aid)
    m = meta.get(aid, {})
    if not m:
        continue

    print(f'========================================')
    print(f'  {name.upper()} ({aid})')
    print(f'========================================')
    print()
    print(f'App: {m[\"desc\"]}')
    print()
    print(f'PROMPT:')
    print(f'---')
    print(f'Design a modern app icon/logo for \"{name}\", {m[\"desc\"].lower()}. ')
    print(f'Style: {m[\"style\"]}. ')
    print(f'Color palette: {m[\"colors\"]}. ')
    print(f'Central symbol: {m[\"symbol\"]}. ')
    print(f'The icon should feel {m[\"vibe\"]}. ')
    print(f'Render as a 1024x1024 icon with rounded corners (iOS/macOS style), ')
    print(f'subtle gradient background, clean vector shapes, no text. ')
    print(f'The design should be recognizable at 16x16 favicon size.')
    print(f'---')
    print()
"
