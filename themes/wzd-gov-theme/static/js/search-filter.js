(function () {
  var panels = document.querySelectorAll('[data-search-panel]');
  if (!panels.length) return;

  var state = {
    posts: null,
    sort: 'time',
    query: ''
  };

  function escapeHtml(value) {
    return String(value || '').replace(/[&<>"']/g, function (ch) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch];
    });
  }

  function normalize(value) {
    return String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();
  }

  function popularityScore(post, index) {
    var ageRank = Math.max(0, 300 - index);
    var imageScore = post.image ? 45 : 0;
    var categoryScore = post.categories && post.categories.length ? 20 : 0;
    var tagScore = post.tags && post.tags.length ? Math.min(25, post.tags.length * 5) : 0;
    var lengthScore = Math.min(35, Math.max(0, Number(post.wordCount || 0) / 60));
    return ageRank + imageScore + categoryScore + tagScore + lengthScore;
  }

  function postText(post) {
    return normalize([
      post.title,
      post.excerpt,
      (post.categories || []).join(' '),
      (post.tags || []).join(' ')
    ].join(' '));
  }

  function filterPosts() {
    var query = normalize(state.query);
    var posts = (state.posts || []).filter(function (post) {
      if (!query) return true;
      return postText(post).indexOf(query) !== -1;
    });

    posts.sort(function (a, b) {
      if (state.sort === 'popular') {
        return (b._score || 0) - (a._score || 0) || (b.timestamp || 0) - (a.timestamp || 0);
      }
      return (b.timestamp || 0) - (a.timestamp || 0);
    });

    return posts;
  }

  function cardHtml(post) {
    var category = (post.categories && post.categories[0]) ? '<span class="category">' + escapeHtml(post.categories[0]) + '</span>' : '';
    var image = post.image
      ? '<a href="' + escapeHtml(post.url) + '" class="post-card-image"><img src="' + escapeHtml(post.image) + '" alt="' + escapeHtml(post.title) + '" loading="lazy"></a>'
      : '';
    return [
      '<article class="post-card search-card">',
      image,
      '<div class="post-card-content">',
      '<h2 class="post-card-title"><a href="' + escapeHtml(post.url) + '">' + escapeHtml(post.title) + '</a></h2>',
      '<p class="post-card-excerpt">' + escapeHtml(post.excerpt) + '</p>',
      '<div class="post-card-meta"><time datetime="' + escapeHtml(post.dateIso || '') + '">' + escapeHtml(post.date) + '</time>' + category + '</div>',
      '</div>',
      '</article>'
    ].join('');
  }

  function render(panel) {
    var results = panel.querySelector('[data-search-results]');
    var meta = panel.querySelector('[data-search-meta]');
    var queryActive = normalize(state.query).length > 0;
    var sortActive = state.sort !== 'time';
    var active = queryActive || sortActive;
    var root = panel.closest('.main-content') || document;

    if (!active) {
      results.hidden = true;
      results.innerHTML = '';
      meta.textContent = '검색어를 입력하거나 정렬 방식을 선택하세요.';
      root.querySelectorAll('.home-latest, .home-more, .list-page > .post-list, .pagination').forEach(function (el) {
        el.hidden = false;
      });
      return;
    }

    var posts = filterPosts().slice(0, 48);
    results.hidden = false;
    results.innerHTML = posts.length
      ? posts.map(cardHtml).join('')
      : '<div class="empty-search">검색 결과가 없습니다.</div>';

    meta.textContent = (queryActive ? '"' + state.query.trim() + '" 검색 결과 ' : '전체 글 ') +
      posts.length + '개 · ' + (state.sort === 'popular' ? '인기순' : '시간순');

    root.querySelectorAll('.home-latest, .home-more, .list-page > .post-list, .pagination').forEach(function (el) {
      el.hidden = true;
    });
  }

  function renderAll() {
    panels.forEach(render);
  }

  function setSort(panel, sort) {
    state.sort = sort;
    panel.querySelectorAll('[data-sort]').forEach(function (btn) {
      btn.classList.toggle('active', btn.getAttribute('data-sort') === sort);
    });
    renderAll();
  }

  function loadPosts() {
    if (state.posts) return Promise.resolve(state.posts);
    return fetch('/posts/index.json', { credentials: 'same-origin' })
      .then(function (res) { return res.ok ? res.json() : []; })
      .then(function (posts) {
        state.posts = posts.map(function (post, index) {
          post._score = popularityScore(post, index);
          return post;
        });
        return state.posts;
      })
      .catch(function () {
        state.posts = [];
        return state.posts;
      });
  }

  panels.forEach(function (panel) {
    var input = panel.querySelector('[data-search-input]');
    var buttons = panel.querySelectorAll('[data-sort]');

    input.addEventListener('input', function () {
      state.query = input.value;
      loadPosts().then(renderAll);
    });

    buttons.forEach(function (btn) {
      btn.addEventListener('click', function () {
        loadPosts().then(function () {
          setSort(panel, btn.getAttribute('data-sort'));
        });
      });
    });
  });
})();
