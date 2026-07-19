/** 
 * @typedef {Object} DocumentPages
 * @property {number} index
 * @property {string} key
 * @property {string} content_type
 * @property {number} size
 * @property {string} hash
 */
// 状态变量
let images = [];
let currentIndex = 0;
let viewerInstance = null;
let docId = null;

// DOM 元素
const imgElement = document.getElementById("displayedImage");
const loadingState = document.getElementById("loadingState");
const loadingText = document.getElementById("loadingText");
const currentEl = document.getElementById("current");
const totalEl = document.getElementById("total");
const btnPrev = document.getElementById("btnPrev");
const btnNext = document.getElementById("btnNext");

// 1. 从 URL 提取 document_id
function getDocumentId() {
    return window.location.search.split('id=')[1] || null;
}

/**
 * 
 * @param {DocumentPages} page 
 */
function getSrc(page) {
    return `https://dmb.hayaseyuuka.date/v1/documents/${docId}/pages/${page.index}?token=viewer`;
}

// 2. 初始化：获取数据
async function init() {
    docId = getDocumentId();
    if (!docId) {
        showError("URL 错误：无法获取文档 ID");
        return;
    }

    try {
        // 请求后端 API
        const response = await fetch(`https://dmb.hayaseyuuka.date/v1/documents/${docId}?token=viewer`);

        if (!response.ok) {
            const errJson = await response.json();
            throw new Error(errJson.detail || `Server Error: ${response.status}`);
        }

        let document_meta = await response.json();
        /** @type {DocumentPages[]} */
        images = document_meta.pages;

        if (!Array.isArray(images) || images.length === 0) {
            throw new Error("文档内容为空");
        }

        // 数据加载成功
        loadingState.style.display = 'none';
        totalEl.innerText = images.length;
        btnPrev.disabled = false;
        btnNext.disabled = false;

        // 加载第一张图
        updateImage();
        initViewer();
        preloadImages(3);

    } catch (err) {
        console.error(err);
        showError(err.message);
    }
}

function showError(msg) {
    loadingText.innerText = msg;
    loadingText.style.color = '#ff5252';
    document.querySelector('.spinner').style.display = 'none';
}

// 3. 核心功能
function initViewer() {
    if (viewerInstance) return;
    viewerInstance = new Viewer(imgElement, {
        inline: false,
        button: true,
        navbar: false,
        title: false,
        toolbar: {
            zoomIn: 1, zoomOut: 1, oneToOne: 1, reset: 1,
            rotateLeft: 1, rotateRight: 1
        },
        transition: false,
        backdrop: 'rgba(0,0,0,0.95)',
    });
}

function updateImage() {
    imgElement.style.opacity = '0.5';
    currentEl.innerText = (currentIndex + 1).toString();

    // 构造新的 src
    // 注意：API 返回的如果是相对路径 (如 "/document_content/1/0") 直接使用
    // 如果 API 返回的是文件名，你需要手动拼 URL
    const newSrc = getSrc(images[currentIndex]);
    // 为了防止 Viewer.js 在图片未加载时出现闪烁，使用 Image 对象预加载
    const tempImg = new Image();
    tempImg.onload = () => {
        imgElement.src = newSrc;
        imgElement.style.opacity = '1';
        if (viewerInstance) viewerInstance.update();
    };
    tempImg.onerror = () => {
        imgElement.alt = "加载失败";
        imgElement.style.opacity = '1';
    };
    tempImg.src = newSrc;
}

function changeImage(direction) {
    if (images.length === 0) return;

    let step = parseInt(document.getElementById("stepInput").value) || 1;
    currentIndex += direction * step;

    // 循环翻页逻辑（可选，如果不想要循环，改为边界锁定）
    if (currentIndex < 0) currentIndex = 0;
    if (currentIndex >= images.length) currentIndex = images.length - 1;

    updateImage();
    preloadImages(2);
}

// 预加载
function preloadImages(limit = 2) {
    for (let i = 1; i <= limit; i++) {
        let nextIndex = currentIndex + i;
        if (nextIndex < images.length) {
            new Image().src = getSrc(images[nextIndex]);
        }
    }
}

// 交互事件监听
window.onload = init;

document.addEventListener('keydown', (e) => {
    if (document.querySelector('.viewer-in')) return;
    if (e.key === 'ArrowLeft') changeImage(-1);
    else if (e.key === 'ArrowRight') changeImage(1);
});

// 触摸滑动
let touchStartX = 0;
document.addEventListener('touchstart', e => {
    touchStartX = e.changedTouches[0].screenX;
}, { passive: true });

document.addEventListener('touchend', e => {
    if (document.body.classList.contains('viewer-open')) return;
    const delta = e.changedTouches[0].screenX - touchStartX;
    if (Math.abs(delta) > 60) {
        if (delta > 0) changeImage(-1);
        else changeImage(1);
    }
});