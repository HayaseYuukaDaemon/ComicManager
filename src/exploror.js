const DROPDOWN_SELECTOR = document.getElementById("category-select");
const DROPDOWN_INPUT = document.getElementById('dropdown-input');
const DOCUMENTS_CONTAINER = document.getElementById('list-container');
const NOW_PAGE_H2 = document.getElementById('now-page');
const TOTAL_PAGE_H2 = document.getElementById('total-page');
const NOW_PAGE_BOTTOM_H2 = document.getElementById('now-page-bottom');
const TOTAL_PAGE_BOTTOM_H2 = document.getElementById('total-page-bottom');
const DROPDOWN_LIST = document.getElementById('dropdown-list');
const TITLE_ITEMS = document.getElementsByClassName('title-item');
const DOCUMENT_INPUT = document.getElementById('document-input');

fetch('/api/tags').then(async response => {
    if(!response.ok){
        DROPDOWN_INPUT.placeholder = 'Tag组更新失败, 禁用一切';
        throw new Error(response.status.toString());
    }
    let tag_groups = await response.json()
    for (const [group_id, group_name] of Object.entries(tag_groups)) {
        let new_option = document.createElement('option');
        new_option.value = group_id;
        new_option.textContent = group_name.toString();
        console.log(`tag组添加: ${new_option}`)
        DROPDOWN_SELECTOR.appendChild(new_option);
    }
    DROPDOWN_INPUT.placeholder = 'Tag组更新完成, 等待选择tag组';
}, reason => {
    DROPDOWN_INPUT.placeholder = 'Tag组更新失败, 禁用一切';
    throw new Error(reason);
});



// 根据不可输入下拉列表中的选择来更新可输入下拉列表内容
function updateDropdownList() {
    DROPDOWN_INPUT.placeholder = '等待更新';
    DROPDOWN_LIST.innerHTML = '';
    fetch(`/api/tags?group_id=${DROPDOWN_SELECTOR.value}`).then(async response => {
        if(!response.ok) {
            DROPDOWN_INPUT.placeholder = `更新失败: ${response.status}`;
            return;
        }
        let tag_infos = await response.json();
        for (const [tag_name, tag_id] of Object.entries(tag_infos)) {
                let new_option = document.createElement('li');
                new_option.setAttribute('tag-id', tag_id.toString());
                new_option.textContent = tag_name;
                DROPDOWN_LIST.appendChild(new_option);
            }
            DROPDOWN_INPUT.placeholder = '更新完成, 输入tag部分以选择';
    }, reason => {
        DROPDOWN_INPUT.placeholder = `更新失败: ${reason}`;
    })
    // 更新输入框内容
    filterList(); // 输入框内容不变时也要调用一次以保证正确的显示
}

// 根据输入框内容实时过滤下拉列表
function filterList() {
    const input = document.getElementById('dropdown-input');
    const filter = input.value.toLowerCase();
    const dropdown_list = document.getElementById('dropdown-list');
    // 显示下拉列表
    dropdown_list.style.display = 'block';
    for (let list_index = 0; list_index < dropdown_list.children.length; list_index++) {
        let now_list_option = dropdown_list.children[list_index];
        const text = now_list_option.textContent;
        // 同时根据分类选择和输入内容进行过滤
        if (text.toLowerCase().indexOf(filter) > -1)
            now_list_option.style.display = '';
        else
            now_list_option.style.display = 'none';
    }
    // 如果输入为空且没有选中项，隐藏下拉列表
    if (filter === '')
        dropdown_list.style.display = 'none';
}

function submitAuthorSearch(event) {
    const author_name = event.target.textContent;
    searchDocuments({author_name: author_name, page: 1, target_tag: 0});
}

function submitTagSearch(event){
    const tag_id = parseInt(event.target.getAttribute('tag-id'), 10);
    searchDocuments({target_tag: tag_id, page: 1, author_name: ''});
}

for (let i = 0; i < TITLE_ITEMS.length; i++) {
    TITLE_ITEMS[i].addEventListener('click', switchPage);
}

const PAGE_SYNC_OBSERVER = new MutationObserver(function (mutations) {
    // noinspection JSUnusedLocalSymbols
    mutations.forEach(mutation => {
        NOW_PAGE_BOTTOM_H2.textContent = NOW_PAGE_H2.textContent;
        TOTAL_PAGE_BOTTOM_H2.textContent = TOTAL_PAGE_H2.textContent;
    });
});
PAGE_SYNC_OBSERVER.observe(NOW_PAGE_H2, {characterData: true, subtree: true, childList: true});
PAGE_SYNC_OBSERVER.observe(TOTAL_PAGE_H2, {characterData: true, subtree: true, childList: true});

// 添加事件监听，使得点击列表项后填充输入框
DROPDOWN_LIST.addEventListener('click', (e) => {
    if (e.target.tagName === 'LI') {
        document.getElementById('dropdown-input').value = e.target.textContent;
        DROPDOWN_LIST.style.display = 'none';  // 选中后隐藏下拉列表
    }
});
// 点击输入框以外区域时隐藏下拉列表
document.addEventListener('click', (e) => {
    if (!DROPDOWN_LIST.contains(e.target) && !DROPDOWN_INPUT.contains(e.target))
        DROPDOWN_LIST.style.display = 'none';
});

function switchPage(event) {
    if (event.target.id === 'page-step') {
        return;
    }
    const now_page = parseInt(NOW_PAGE_H2.textContent, 10);
    const total_page = parseInt(TOTAL_PAGE_H2.textContent, 10);
    const page_step = parseInt(document.getElementById('page-step').value, 10) ?
        parseInt(document.getElementById('page-step').value, 10) : 1;
    let target_page = 1;
    if (event.target.id.startsWith('prev-page-button')) {
        if (now_page <= page_step) return;
        target_page = now_page - page_step;
    } else if (event.target.id.startsWith('next-page-button')) {
        if (now_page + page_step > total_page) return;
        target_page = now_page + page_step;
    } else {
        alert('不是翻页按钮，无法应用功能');
    }
    searchDocuments(buildSearchArgs(target_page));
}


/**
 * @typedef {{target_tag: number, author_name: string, page: number}} SearchArgs
 */

/**
 * @param {number} target_page
 * @return SearchArgs
 */
function buildSearchArgs(target_page) {
    if (target_page === null)target_page = 1
    let search_args = {target_tag: 0, author_name: '', page: target_page};
    const tag_name = document.getElementById('dropdown-input').value;
    const tag_select_list = document.getElementById('dropdown-list');
    let tag_id = 0;
    for (let i = 0; i < tag_select_list.children.length; i++) {
        let tag_select = tag_select_list.children[i];
        if (tag_select.textContent === tag_name) {
            tag_id = tag_select.getAttribute('tag-id');
            console.log('已查询到指定tag: ' + tag_id)
        }
    }
    search_args.author_name = DOCUMENT_INPUT.value;
    search_args.target_tag = tag_id;
    return search_args;
}

/**
 * @param {URLSearchParams} search_params
 */
function fillSearchArgs(search_params){
    let target_tag = search_params.get('target_tag');
    let author_name = search_params.get('author_name');
    NOW_PAGE_H2.textContent = search_params.get('page') ? search_params.get('page') : '1';
    if(author_name)
        DOCUMENT_INPUT.value = author_name;
    if(parseInt(target_tag, 10)){
        fetch(`/api/tags/${target_tag}`).then(async response => {
            if (!response.ok){
                alert(`无法获取到目标tag,${response.status}`);
                return
            }
            let tag_info = await response.json();
            DROPDOWN_INPUT.value = tag_info.name;
            DROPDOWN_SELECTOR.value = tag_info.group_id.toString();
            updateDropdownList();
            DROPDOWN_LIST.style.display = 'none';
        }).catch(reason => {
            alert(`无法获取到目标tag,${reason}`);
        })
    }
}


/**
 * @param {SearchArgs} search_args
 * @return {URLSearchParams} url_params
 */
function parseSearchArgs(search_args){
    return new URLSearchParams(Object.entries(search_args).map(([key, value]) => [key, String(value)]));
}


/**
 * 请求删除文档
 * @param {number} document_id
 */
function requestDeleteDocument(document_id) {
    const is_confirmed = confirm(`确定要删除id为${document_id}的文档吗`)
    if (!is_confirmed) return;
    fetch(`/api/documents/${document_id}`, {
        method: 'DELETE'
    }).then(async response => {
        // fetch 不会将 4xx/5xx 视为异常，需通过 response.ok 判断
        if (response.ok) {
            alert('删除成功');
            // 3. 刷新当前页面列表
            const now_page_element = document.getElementById('now-page');
            const now_page = parseInt(now_page_element ? now_page_element.textContent : '1', 10);
            searchDocuments(buildSearchArgs(now_page));
        } else {
            // 处理非 2xx 响应 (对应 jQuery 的 error 回调)
            let errorMsg = "删除失败";
            // 尝试读取并解析 JSON 响应体以获取 detail
            const data = await response.json();
            if (data && data.detail) {
                errorMsg += ": " + data.detail;
            }
            else if (response.status === 403) {
                errorMsg += ": 权限不足";
            } else {
                errorMsg += ": 未知错误 (" + response.status + ")";
            }
            alert(errorMsg);
        }
    }).catch(error => {
        // 处理网络故障（如 DNS 解析失败、拒绝连接等）
        console.error('Fetch error:', error);
        alert("删除失败: 网络请求错误");
    });
}

/**
 * @typedef {Object} DocumentInfo
 * @property {number} document_id - 对应 document_id (PK)
 * @property {string} title - 对应 title
 * @property {string} file_path - 对应 file_path
 * @property {?string} series_name - 对应 Optional[str]，使用 ? 表示可为 null
 * @property {?number} volume_number - 对应 Optional[int]
 */

/**
 * @typedef {Object} TagInfo
 * @property {number} tag_id - 对应 tag_id (PK)
 * @property {string} name - 对应 name
 * @property {?string} hitomi_alter - 对应 Optional[str]
 * @property {?number} group_id - 对应 Optional[int]
 */

/**
 * @typedef {Object} AuthorInfo
 * @property {number} author_id
 * @property {string} name - 对应 name
 */

/**
 * @typedef {Object} DocumentMeta
 * @property {DocumentInfo} document_info
 * @property {Array<TagInfo>} document_tags
 * @property {Array<AuthorInfo>} document_authors
 * @property {Array<string>} document_pages
 */


/**
 * 构造文档
 * @param {DocumentMeta} document_meta
 * @returns {HTMLDivElement}
 */
function constructDocument(document_meta) {
    let document_id = document_meta.document_info.document_id;
    console.log(`现在开始构造文档: ${document_id}`);
    let document_item = document.createElement('div');
    document_item.className = 'list-item';
    let document_thumbnail = document.createElement('img');
    document_thumbnail.className = 'thumbnail';
    document_thumbnail.src = `/api/documents/${document_meta.document_info.document_id}/thumbnail`;
    document_item.appendChild(document_thumbnail);
    let document_details = document.createElement('div');
    document_details.className = 'details'
    let document_title = document.createElement('h3');
    let document_link = document.createElement('a');
    document_link.href = `/show_document/${document_id}`;
    document_link.textContent = document_meta.document_info.title;
    document_link.target = '_blank';
    document_title.appendChild(document_link);
    document_details.appendChild(document_title);
    document_meta.document_authors.forEach(author_name => {
        let document_author = document.createElement('button');
        document_author.addEventListener("click", submitAuthorSearch);
        document_author.textContent = author_name.name;
        document_details.appendChild(document_author);
    })
    let document_tags = document.createElement('div');
    document_tags.className = 'tag-info';
    document_meta.document_tags.forEach(tag => {
        let single_tag = document.createElement('span');
        single_tag.textContent = tag.name;
        single_tag.setAttribute('tag-id', tag.tag_id.toString());
        single_tag.setAttribute('tag-group', tag.group_id.toString());
        single_tag.addEventListener('click', submitTagSearch);
        document_tags.appendChild(single_tag);
    })
    document_details.appendChild(document_tags);
    let delete_btn = document.createElement('button');
    delete_btn.textContent = '删除';
    delete_btn.style.color = 'red'; // 简单样式，也可在css中定义class
    delete_btn.style.marginLeft = '10px';
    delete_btn.style.cursor = 'pointer';
    // 绑定点击事件，调用删除逻辑
    delete_btn.onclick = function() {
        requestDeleteDocument(document_id);
    };
    document_details.appendChild(delete_btn);
    document_item.appendChild(document_details);
    return document_item;
}


/**
 * 定义 HTMX 事件的 detail 结构
 * @typedef {Object} HtmxRequestDetail
 * @property {HTMLElement} elt - 触发请求的元素 (The triggering element)
 * @property {HTMLElement} target - 目标交换元素 (The target of the content swap)
 * @property {XMLHttpRequest} xhr - 原生的 XHR 对象 (The XMLHttpRequest)
 * @property {Object} requestConfig - 请求配置 (Request configuration)
 * @property {string} path - 请求的路径
 * @property {boolean} successful - 请求是否成功 (2xx)
 * @property {boolean} failed - 请求是否失败
 */

/**
 * 定义 HTMX 事件本身
 * 这是一个 CustomEvent，但它的 detail 属性是我们上面定义的结构
 * @typedef {CustomEvent & { detail: HtmxRequestDetail }} HtmxAfterRequestEvent
 */

// noinspection JSUnusedGlobalSymbols
/**
 * @param {HtmxAfterRequestEvent} evt
 */
function documentCallback(evt){
    const xhr = evt.detail.xhr;
    console.log(`触发documentCallback`)
    if (evt.detail.successful) {
        const target_div = evt.detail.elt;
        try {
            // 3. 成功：调用构建函数
            const responseData = JSON.parse(xhr.response);
            const newElement = constructDocument(responseData);
            // 4. 替换原对象 (原 div 会从 DOM 中移除，被新 div 取代)
            if (target_div && target_div.parentNode) {
                target_div.replaceWith(newElement);
            }
        } catch (err) {
            console.error("构建 DOM 时出错:", err);
            target_div.innerHTML = `<span style="color:red">数据处理异常</span>`;
        }
    } else {
        let error_msg = document.createElement('p');
        let server_detail = null;
        if (xhr.response){
            server_detail = JSON.parse(xhr.response).detail;
        }
        error_msg.textContent = server_detail || xhr.statusText || "未知网络错误";
        let error_code = document.createElement('p');
        error_code.textContent = xhr.status.toString();
        let error_div = document.createElement('div');
        error_div.style.color = 'red';
        error_div.style.border = '1px solid red';
        error_div.style.padding = '10px';
        let strong_info = document.createElement('strong')
        strong_info.textContent = '加载失败';
        error_div.appendChild(strong_info);
        error_div.appendChild(error_code);
        error_div.appendChild(error_msg);
        evt.detail.elt.replaceWith(error_div);
    }
}


/**
 * @param {{total_count: number, results: Array<number>}} response
 */
function unpackSearchResponse(response){
    DOCUMENTS_CONTAINER.innerHTML = '';
    let document_count = response.total_count;
    const total_page_item = document.getElementById('total-page');
    total_page_item.textContent = Math.ceil(document_count / 10).toString();
    console.log('清空文档容器');
    DOCUMENTS_CONTAINER.innerHTML = '';
    console.log('开始构造文档列表');
    response.results.forEach(document_id => {
        let document_item = document.createElement('div');
        document_item.setAttribute('hx-get', `/api/documents/${document_id}`);
        document_item.setAttribute('hx-trigger', 'load')
        document_item.setAttribute('hx-on::after-request', 'documentCallback(event)')
        // document_item.setAttribute('hx-swap', 'none');
        DOCUMENTS_CONTAINER.appendChild(document_item);
    });
    if (htmx === undefined) {
        htmx = Object;
        htmx.process = () => {};
    }
    htmx.process(DOCUMENTS_CONTAINER);
}


window.addEventListener('popstate', function(e) {
    // 触发 popstate 时，浏览器的 URL 地址栏已经发生变化
    // 解析当前 URL 参数并重新发起搜索，此时参数传 false 避免重复 pushState
    /** @type {SearchArgs} */
    let query_args = e.state;
    console.log(`已拦截pop事件, 获取参数: ${JSON.stringify(query_args)}`);

    if (query_args === null)
        query_args = buildSearchArgs(1);
    searchDocuments(query_args, false);
});


/**
 * @param {?SearchArgs} search_object
 * @param {?boolean} push_to_history
 */
function searchDocuments(search_object, push_to_history = true) {
    let search_params;
    if(search_object === null)
        search_object = buildSearchArgs(1);
    else {
        search_params = parseSearchArgs(search_object);
        fillSearchArgs(search_params);
    }


    let query_url_params = search_params.toString();
    console.log('查询参数: ' + search_params.toString());
    // window.location.search = search_params.toString();
    if (push_to_history)
        window.history.pushState(search_object, '', window.location.pathname + (query_url_params ? '?' + query_url_params : ''));

    fetch(`/api/documents/?${query_url_params}`).then(async response => {
        console.log('搜索成功返回');
        unpackSearchResponse(await response.json());
        fillSearchArgs(search_params);
    })
}
