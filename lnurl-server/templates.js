// All templates consolidated into single file

// Vercel-inspired CSS design system
const getStyles = () => `
    /* Reset and base styles */
    * {
        margin: 0;
        padding: 0;
        box-sizing: border-box;
    }

    /* Design tokens */
    :root {
        /* Colors - Vercel/Geist design system */
        --geist-background: #ffffff;
        --geist-foreground: #000000;
        --geist-selection: #79ffe1;
        --accents-1: #fafafa;
        --accents-2: #eaeaea;
        --accents-3: #999999;
        --accents-4: #888888;
        --accents-5: #666666;
        --accents-6: #444444;
        --accents-7: #333333;
        --accents-8: #111111;

        /* Semantic colors */
        --geist-success: #0cad00;
        --geist-error: #e00000;
        --geist-warning: #f5a623;
        --geist-cyan: #50e3c2;
        --geist-violet: #7928ca;

        /* Typography */
        --font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", "Roboto", "Oxygen", "Ubuntu", "Cantarell", "Fira Sans", "Droid Sans", "Helvetica Neue", sans-serif;
        --font-mono: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, Courier, monospace;

        /* Spacing */
        --gap: 16px;
        --gap-half: 8px;
        --gap-quarter: 4px;
        --gap-double: 32px;
        --gap-triple: 48px;

        /* Radii */
        --radius: 6px;
        --radius-small: 4px;
        --radius-large: 8px;

        /* Shadows */
        --shadow-small: 0 2px 8px rgba(0, 0, 0, 0.12);
        --shadow-medium: 0 4px 16px rgba(0, 0, 0, 0.12);
        --shadow-large: 0 8px 32px rgba(0, 0, 0, 0.12);

        /* Transitions */
        --transition: 150ms ease;
    }

    /* Dark theme */
    [data-theme="dark"] {
        --geist-background: #000000;
        --geist-foreground: #ffffff;
        --accents-1: #111111;
        --accents-2: #333333;
        --accents-3: #444444;
        --accents-4: #666666;
        --accents-5: #888888;
        --accents-6: #999999;
        --accents-7: #eaeaea;
        --accents-8: #fafafa;

        --shadow-small: 0 2px 8px rgba(0, 0, 0, 0.4);
        --shadow-medium: 0 4px 16px rgba(0, 0, 0, 0.4);
        --shadow-large: 0 8px 32px rgba(0, 0, 0, 0.4);
    }

    /* Base styles */
    body {
        background-color: var(--geist-background);
        color: var(--geist-foreground);
        font-family: var(--font-sans);
        line-height: 1.6;
        min-height: 100vh;
        padding: var(--gap-double) var(--gap);
        transition: background-color var(--transition), color var(--transition);
    }

    /* Layout */
    .container {
        max-width: 1000px;
        margin: 0 auto;
    }

    /* Typography */
    h1, h2, h3, h4, h5, h6 {
        font-weight: 600;
        line-height: 1.25;
        margin-bottom: var(--gap-half);
    }

    h1 {
        font-size: 2.5rem;
        font-weight: 800;
        display: flex;
        align-items: center;
        gap: var(--gap-half);
        justify-content: center;
        margin-bottom: var(--gap-quarter);
    }

    h2 {
        font-size: 1.5rem;
    }

    h3 {
        font-size: 1.2rem;
    }

    p {
        color: var(--accents-5);
        margin-bottom: var(--gap);
    }

    /* Header */
    .header {
        text-align: center;
        margin-bottom: var(--gap-double);
    }

    .header p {
        font-size: 1.1rem;
        margin-bottom: 0;
    }

    /* Icons */
    .icon, .icon-title, .btn-icon {
        width: 24px;
        height: 24px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
    }

    .icon-title {
        color: #f7931a;
        width: 32px;
        height: 32px;
    }

    .btn-icon {
        width: 16px;
        height: 16px;
    }

    /* Cards */
    .cards-container {
        display: grid;
        gap: var(--gap-double);
        margin-bottom: var(--gap-double);
    }

    .card {
        padding: 0;
    }


    .card-header {
        display: flex;
        align-items: center;
        gap: var(--gap-half);
        margin-bottom: var(--gap);
    }

    .card-title {
        margin: 0;
        color: var(--geist-foreground);
    }

    .card-description {
        color: var(--accents-5);
        margin-bottom: var(--gap-double);
        line-height: 1.5;
    }

    /* Endpoints */
    .endpoints-list {
        display: grid;
        gap: var(--gap-half);
    }

    .endpoint {
        display: flex;
        align-items: center;
        gap: var(--gap-half);
        padding: var(--gap-half) var(--gap);
        background: var(--accents-1);
        border: 1px solid var(--accents-2);
        border-radius: var(--radius);
        text-decoration: none;
        color: inherit;
        transition: background-color 100ms ease;
    }

    .endpoint.clickable:hover {
        background: rgba(0, 0, 0, 0.05);
    }

    [data-theme="dark"] .endpoint.clickable:hover {
        background: rgba(255, 255, 255, 0.05);
    }

    .endpoint:focus {
        outline: none;
    }


    .endpoint-method {
        font-weight: 600;
        font-size: 0.75rem;
        color: var(--geist-success);
        min-width: 35px;
        font-family: var(--font-mono);
        text-transform: uppercase;
    }

    .endpoint-path {
        font-family: var(--font-mono);
        font-size: 0.875rem;
        color: var(--geist-foreground);
        flex: 1;
    }


    .endpoint-desc {
        color: var(--accents-5);
        font-size: 0.875rem;
        margin-left: auto;
    }

    /* Buttons */
    .btn {
        display: inline-flex;
        align-items: center;
        gap: var(--gap-half);
        padding: var(--gap-half) var(--gap);
        text-decoration: none;
        border-radius: var(--radius);
        font-weight: 500;
        font-size: 0.875rem;
        border: 1px solid transparent;
        cursor: pointer;
        line-height: 1;
    }

    .btn-primary {
        background: var(--geist-foreground);
        color: var(--geist-background);
        border-color: var(--geist-foreground);
        transition: all 0.2s ease;
    }

    .btn-primary:hover {
        background: var(--accents-7);
        border-color: var(--accents-7);
    }

    .btn-primary:focus {
        outline: none;
        box-shadow: 0 0 0 2px var(--accents-2);
    }


    .btn-secondary {
        background: transparent;
        color: var(--accents-5);
        border-color: var(--accents-2);
    }


    .btn-group {
        display: flex;
        gap: var(--gap-half);
        justify-content: center;
        flex-wrap: wrap;
    }


    /* QR Code styles */
    .qr-container {
        text-align: center;
        max-width: 400px;
        margin: 0 auto;
    }

    .qr-code {
        max-width: 100%;
        height: auto;
        margin: var(--gap-double) 0;
    }

    .qr-title {
        color: var(--geist-foreground);
        margin-bottom: var(--gap);
        font-size: 1.25rem;
        font-weight: 600;
        display: flex;
        align-items: center;
        justify-content: center;
        gap: var(--gap-half);
    }

    .qr-url {
        font-family: var(--font-mono);
        font-size: 0.875rem;
        color: var(--accents-5);
        word-break: break-all;
        margin-top: var(--gap-double);
        padding: var(--gap);
        background: var(--accents-1);
        border-radius: var(--radius);
        border: 1px solid var(--accents-2);
    }

    /* QR page specific */
    .qr-page {
        display: flex;
        justify-content: center;
        align-items: center;
        min-height: 100vh;
    }

    .qr-page .container {
        width: 100%;
        padding: var(--gap);
    }


    /* Responsive design */
    @media (max-width: 768px) {
        body {
            padding: var(--gap) var(--gap-half);
        }

        h1 {
            font-size: 2rem;
            flex-direction: column;
            gap: var(--gap-quarter);
        }

        .card {
            padding: var(--gap);
        }

        .btn-group {
            flex-direction: column;
            align-items: center;
        }

        .qr-container {
            padding: var(--gap-double);
            margin: var(--gap);
        }

        .endpoint {
            flex-direction: column;
            align-items: flex-start;
            gap: var(--gap-quarter);
        }

        .endpoint-desc {
            margin-left: 0;
        }
    }


    /* Focus styles */
    *:focus {
        outline: 2px solid var(--geist-foreground);
        outline-offset: 2px;
    }
`;

// Main layout template
const mainLayout = ({ title, content }) => `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${title}</title>
    <link rel="stylesheet" href="https://unpkg.com/lucide-static@0.454.0/font/lucide.css">
    <style>${getStyles()}</style>
    <script>
        // Set theme based on OS preference
        if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
            document.documentElement.setAttribute('data-theme', 'dark');
        } else {
            document.documentElement.setAttribute('data-theme', 'light');
        }

        // Listen for OS theme changes
        if (window.matchMedia) {
            window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', e => {
                document.documentElement.setAttribute('data-theme', e.matches ? 'dark' : 'light');
            });
        }
    </script>
</head>
<body>
    ${content}
</body>
</html>
`;

// Reusable HTML components
const header = ({ title, subtitle }) => `
    <div class="header">
        <h1><i class="icon-zap icon-title"></i>${title}</h1>
        ${subtitle ? `<p>${subtitle}</p>` : ''}
    </div>
`;

const endpoint = ({ method, path, description, clickable = false }) => `
    ${clickable ?
        `<a href="${path}" class="endpoint clickable">
            <span class="endpoint-method">${method}</span>
            <span class="endpoint-path">${path}</span>
            <span class="endpoint-desc">${description}</span>
        </a>` :
        `<div class="endpoint">
            <span class="endpoint-method">${method}</span>
            <span class="endpoint-path">${path}</span>
            <span class="endpoint-desc">${description}</span>
        </div>`
    }
`;

const card = ({ icon, title, description, endpoints }) => `
    <div class="card">
        <div class="card-header">
            <i class="icon-${icon} icon"></i>
            <h2 class="card-title">${title}</h2>
        </div>
        ${description ? `<div class="card-description">${description}</div>` : ''}
        <div class="endpoints-list">
            ${endpoints.map(ep => endpoint(ep)).join('')}
        </div>
    </div>
`;

const container = ({ content }) => `
    <div class="container">
        ${content}
    </div>
`;

// Page templates
const renderRootPage = ({ health, domain }) => {
    const content = container({
        content: `
            ${header({
                title: 'Bitkit Dev Server'
            })}

            <div class="cards-container">
                ${card({
                    icon: 'wrench',
                    title: 'Generate',
                    endpoints: [
                        {
                            method: 'GET',
                            path: '/generate',
                            description: 'Interactive generator UI',
                            clickable: true
                        },
                        {
                            method: 'GET',
                            path: '/generate/auth',
                            description: 'Generate LNURL-auth',
                            clickable: true
                        },
                        {
                            method: 'GET',
                            path: '/generate/pay',
                            description: 'Generate LNURL-pay',
                            clickable: true
                        },
                        {
                            method: 'GET',
                            path: '/generate/withdraw',
                            description: 'Generate LNURL-withdraw',
                            clickable: true
                        },
                        {
                            method: 'GET',
                            path: '/generate/channel',
                            description: 'Generate LNURL-channel',
                            clickable: true
                        },
                        {
                            method: 'GET',
                            path: '/generate/bolt11',
                            description: 'Generate Bolt11 invoice',
                            clickable: true
                        }
                    ]
                })}

                ${card({
                    icon: 'code',
                    title: 'Decode',
                    endpoints: [
                        {
                            method: 'GET',
                            path: '/decode',
                            description: 'Interactive decoder UI',
                            clickable: true
                        }
                    ]
                })}

                ${card({
                    icon: 'chart-bar',
                    title: 'Admin',
                    endpoints: [
                        {
                            method: 'GET',
                            path: '/health',
                            description: 'Service health check',
                            clickable: true
                        },
                        {
                            method: 'GET',
                            path: '/payments',
                            description: 'List all payments',
                            clickable: true
                        },
                        {
                            method: 'GET',
                            path: '/withdrawals',
                            description: 'List all withdrawals',
                            clickable: true
                        },
                        {
                            method: 'GET',
                            path: '/channels',
                            description: 'List channel requests',
                            clickable: true
                        },
                        {
                            method: 'GET',
                            path: '/sessions',
                            description: 'List auth sessions',
                            clickable: true
                        },
                        {
                            method: 'GET',
                            path: '/address',
                            description: 'Get LND funding address',
                            clickable: true
                        },
                        {
                            method: 'GET',
                            path: '/balance',
                            description: 'Get LND wallet balance',
                            clickable: true
                        }
                    ]
                })}
            </div>
        `
    });

    return mainLayout({
        title: 'Bitkit LNURL Dev Server - API Directory',
        content
    });
};

const renderGeneratorPage = ({}) => {
    const content = container({
        content: `
            ${header({
                title: 'Bitkit LNURL Generator'
            })}

            <div class="cards-container">
                ${card({
                    icon: 'key',
                    title: 'LNURL-auth',
                    endpoints: [
                        {
                            method: 'GET',
                            path: '/generate/auth',
                            description: 'Generate LNURL-auth code',
                            clickable: true
                        },
                        {
                            method: 'GET',
                            path: '/generate/auth/qr',
                            description: 'Generate LNURL-auth QR code',
                            clickable: true
                        }
                    ]
                })}

                ${card({
                    icon: 'credit-card',
                    title: 'LNURL-pay',
                    endpoints: [
                        {
                            method: 'GET',
                            path: '/generate/pay',
                            description: 'Generate LNURL-pay code',
                            clickable: true
                        },
                        {
                            method: 'GET',
                            path: '/generate/pay/qr',
                            description: 'Generate LNURL-pay QR code',
                            clickable: true
                        }
                    ]
                })}

                ${card({
                    icon: 'download',
                    title: 'LNURL-withdraw',
                    endpoints: [
                        {
                            method: 'GET',
                            path: '/generate/withdraw',
                            description: 'Generate LNURL-withdraw code',
                            clickable: true
                        },
                        {
                            method: 'GET',
                            path: '/generate/withdraw/qr',
                            description: 'Generate LNURL-withdraw QR code',
                            clickable: true
                        }
                    ]
                })}

                ${card({
                    icon: 'git-branch',
                    title: 'LNURL-channel',
                    endpoints: [
                        {
                            method: 'GET',
                            path: '/generate/channel',
                            description: 'Generate LNURL-channel code',
                            clickable: true
                        },
                        {
                            method: 'GET',
                            path: '/generate/channel/qr',
                            description: 'Generate LNURL-channel QR code',
                            clickable: true
                        }
                    ]
                })}

                ${card({
                    icon: 'zap',
                    title: 'Bolt11',
                    endpoints: [
                        {
                            method: 'GET',
                            path: '/generate/bolt11',
                            description: 'Generate Bolt11 invoice code',
                            clickable: true
                        },
                        {
                            method: 'GET',
                            path: '/generate/bolt11/qr',
                            description: 'Generate Bolt11 invoice QR code',
                            clickable: true
                        },
                        {
                            method: 'GET',
                            path: '/generate/bolt11?amount=2000',
                            description: 'Generate Bolt11 with custom amount',
                            clickable: true
                        }
                    ]
                })}
            </div>
        `
    });

    return mainLayout({
        title: 'Bitkit LNURL Generator',
        content
    });
};

const renderQrPage = ({ type, qrCode, url }) => {
    const content = `
        <div class="qr-page">
            <div class="container">
                <div class="qr-container">
                    <h1 class="qr-title">
                        <i class="icon-qr-code icon"></i>
                        LNURL ${type.toUpperCase()}
                    </h1>
                    <img src="${qrCode}" alt="LNURL ${type} QR Code" class="qr-code" />
                    ${url ? `
                        <div class="qr-url">
                            ${url}
                        </div>
                    ` : ''}
                </div>
            </div>
        </div>
    `;

    return mainLayout({
        title: `LNURL ${type.toUpperCase()} QR Code`,
        content
    });
};

const renderDecoderPage = () => {
    const content = container({
        content: `
            ${header({
                title: 'Lightning & LNURL Decode'
            })}

            <div class="decode-container">
                <div class="tab-container">
                    <div class="tabs">
                        <button class="tab-btn active" data-tab="lightning">Lightning Invoice</button>
                        <button class="tab-btn" data-tab="lnurl-decode">LNURL Decode</button>
                        <button class="tab-btn" data-tab="lnurl-encode">LNURL Encode</button>
                    </div>

                    <div id="lightning" class="tab-content active">
                        <div class="input-section">
                            <label for="lightning-input">Lightning Invoice (BOLT11)</label>
                            <textarea
                                id="lightning-input"
                                class="decode-input"
                                placeholder="lnbc1..."
                                rows="3"
                            ></textarea>
                            <button onclick="decodeLightning()" class="btn btn-primary">Decode Invoice</button>
                        </div>
                        <div class="output-section">
                            <div class="output-header">
                                <label>Decoded Output</label>
                                <button onclick="copyOutput('lightning-output')" class="btn-copy">Copy</button>
                            </div>
                            <pre id="lightning-output" class="decode-output">Enter a Lightning invoice above to decode it</pre>
                        </div>
                    </div>

                    <div id="lnurl-decode" class="tab-content">
                        <div class="input-section">
                            <label for="lnurl-decode-input">LNURL String</label>
                            <textarea
                                id="lnurl-decode-input"
                                class="decode-input"
                                placeholder="lnurl1..."
                                rows="3"
                            ></textarea>
                            <button onclick="decodeLnurl()" class="btn btn-primary">Decode LNURL</button>
                        </div>
                        <div class="output-section">
                            <div class="output-header">
                                <label>Decoded Output</label>
                                <button onclick="copyOutput('lnurl-decode-output')" class="btn-copy">Copy</button>
                            </div>
                            <pre id="lnurl-decode-output" class="decode-output">Enter an LNURL string above to decode it</pre>
                        </div>
                    </div>

                    <div id="lnurl-encode" class="tab-content">
                        <div class="input-section">
                            <label for="lnurl-encode-input">URL to Encode</label>
                            <textarea
                                id="lnurl-encode-input"
                                class="decode-input"
                                placeholder="https://..."
                                rows="3"
                            ></textarea>
                            <button onclick="encodeLnurl()" class="btn btn-primary">Encode to LNURL</button>
                        </div>
                        <div class="output-section">
                            <div class="output-header">
                                <label>Encoded Output</label>
                                <button onclick="copyOutput('lnurl-encode-output')" class="btn-copy">Copy</button>
                            </div>
                            <pre id="lnurl-encode-output" class="decode-output">Enter a URL above to encode it as LNURL</pre>
                        </div>
                    </div>
                </div>
            </div>

            <style>
                .decode-container {
                    margin-top: var(--gap-double);
                }

                .tab-container {
                    background: var(--geist-background);
                    border: 1px solid var(--accents-2);
                    border-radius: var(--radius-large);
                    overflow: hidden;
                }

                .tabs {
                    display: flex;
                    background: var(--accents-1);
                }

                .tab-btn {
                    flex: 1;
                    padding: var(--gap);
                    background: none;
                    border: none;
                    font-family: var(--font-sans);
                    font-size: 0.875rem;
                    font-weight: 500;
                    color: var(--accents-5);
                    cursor: pointer;
                    transition: all 0.2s ease;
                }

                .tab-btn:hover {
                    background: var(--accents-2);
                    color: var(--geist-foreground);
                }

                .tab-btn.active {
                    background: var(--geist-background);
                    color: var(--geist-foreground);
                    border-bottom: none;
                    margin-bottom: 0;
                }

                .tab-btn:focus {
                    outline: none;
                }

                .tab-content {
                    display: none;
                    padding: var(--gap-double);
                }

                .tab-content.active {
                    display: block;
                }

                .input-section {
                    margin-bottom: var(--gap-double);
                }

                .input-section label {
                    display: block;
                    font-weight: 500;
                    margin-bottom: var(--gap-half);
                    color: var(--geist-foreground);
                }

                .decode-input {
                    width: 100%;
                    padding: var(--gap);
                    border: 1px solid var(--accents-4);
                    border-radius: var(--radius);
                    font-family: var(--font-mono);
                    font-size: 0.875rem;
                    background: var(--geist-background);
                    color: var(--geist-foreground);
                    resize: vertical;
                    min-height: 80px;
                    margin-bottom: var(--gap);
                }

                .decode-input:focus {
                    outline: none;
                    border-color: var(--geist-foreground);
                }

                .output-section {
                    margin-top: var(--gap-double);
                }

                .output-header {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    margin-bottom: var(--gap-half);
                }

                .output-header label {
                    font-weight: 500;
                    color: var(--geist-foreground);
                }

                .btn-copy {
                    padding: var(--gap-quarter) var(--gap-half);
                    background: var(--accents-1);
                    border: 1px solid var(--accents-2);
                    border-radius: var(--radius-small);
                    font-size: 0.75rem;
                    color: var(--accents-5);
                    cursor: pointer;
                    transition: all 0.2s ease;
                }

                .btn-copy:hover {
                    background: var(--accents-2);
                    color: var(--geist-foreground);
                }
                .btn-copy:focus {
                    outline: none;
                }

                .decode-output {
                    width: 100%;
                    min-height: 200px;
                    padding: var(--gap);
                    background: var(--accents-1);
                    border: 1px solid var(--accents-2);
                    border-radius: var(--radius);
                    font-family: var(--font-mono);
                    font-size: 0.875rem;
                    color: var(--geist-foreground);
                    white-space: pre-wrap;
                    word-wrap: break-word;
                    overflow-x: auto;
                }

                .error {
                    color: var(--geist-error);
                }

                .success {
                    color: var(--geist-success);
                }
            </style>

            <script>
                // Tab switching functionality
                document.querySelectorAll('.tab-btn').forEach(btn => {
                    btn.addEventListener('click', function() {
                        // Remove active class from all tabs and content
                        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
                        document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));

                        // Add active class to clicked tab
                        this.classList.add('active');

                        // Show corresponding content
                        const tabId = this.getAttribute('data-tab');
                        document.getElementById(tabId).classList.add('active');
                    });
                });

                // Decode Lightning invoice
                async function decodeLightning() {
                    const input = document.getElementById('lightning-input').value.trim();
                    const output = document.getElementById('lightning-output');

                    if (!input) {
                        output.textContent = 'Please enter a Lightning invoice';
                        output.className = 'decode-output error';
                        return;
                    }

                    try {
                        const response = await fetch('/decode/lightning', {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json'
                            },
                            body: JSON.stringify({ invoice: input })
                        });

                        const result = await response.json();

                        if (result.success) {
                            output.textContent = JSON.stringify(result.decoded, null, 2);
                            output.className = 'decode-output success';
                        } else {
                            output.textContent = 'Error: ' + result.error;
                            output.className = 'decode-output error';
                        }
                    } catch (error) {
                        output.textContent = 'Network error: ' + error.message;
                        output.className = 'decode-output error';
                    }
                }

                // Decode LNURL
                async function decodeLnurl() {
                    const input = document.getElementById('lnurl-decode-input').value.trim();
                    const output = document.getElementById('lnurl-decode-output');

                    if (!input) {
                        output.textContent = 'Please enter an LNURL string';
                        output.className = 'decode-output error';
                        return;
                    }

                    try {
                        const response = await fetch('/decode/lnurl/decode', {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json'
                            },
                            body: JSON.stringify({ lnurlString: input })
                        });

                        const result = await response.json();

                        if (result.success) {
                            output.textContent = result.decoded;
                            output.className = 'decode-output success';
                        } else {
                            output.textContent = 'Error: ' + result.error;
                            output.className = 'decode-output error';
                        }
                    } catch (error) {
                        output.textContent = 'Network error: ' + error.message;
                        output.className = 'decode-output error';
                    }
                }

                // Encode URL to LNURL
                async function encodeLnurl() {
                    const input = document.getElementById('lnurl-encode-input').value.trim();
                    const output = document.getElementById('lnurl-encode-output');

                    if (!input) {
                        output.textContent = 'Please enter a URL to encode';
                        output.className = 'decode-output error';
                        return;
                    }

                    try {
                        const response = await fetch('/decode/lnurl/encode', {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json'
                            },
                            body: JSON.stringify({ url: input })
                        });

                        const result = await response.json();

                        if (result.success) {
                            output.textContent = JSON.stringify(result.encoded, null, 2);
                            output.className = 'decode-output success';
                        } else {
                            output.textContent = 'Error: ' + result.error;
                            output.className = 'decode-output error';
                        }
                    } catch (error) {
                        output.textContent = 'Network error: ' + error.message;
                        output.className = 'decode-output error';
                    }
                }

                // Copy output to clipboard
                async function copyOutput(elementId) {
                    const element = document.getElementById(elementId);
                    try {
                        await navigator.clipboard.writeText(element.textContent);

                        // Show feedback
                        const btn = event.target;
                        const originalText = btn.textContent;
                        btn.textContent = 'Copied!';
                        btn.style.color = 'var(--geist-success)';

                        setTimeout(() => {
                            btn.textContent = originalText;
                            btn.style.color = '';
                        }, 2000);
                    } catch (error) {
                        console.error('Failed to copy:', error);
                    }
                }
            </script>
        `
    });

    return mainLayout({
        title: 'Lightning & LNURL Decode - Bitkit Dev Server',
        content
    });
};

module.exports = {
    renderRootPage,
    renderGeneratorPage,
    renderQrPage,
    renderDecoderPage
};
