// Node modules
var gulp = require('gulp');
var watch = require('gulp-watch');
var plumber = require('gulp-plumber');
var preservetime = require('gulp-preservetime');
var gutil = require('gulp-util');
var tap = require('gulp-tap');
var jsonlint = require('gulp-jsonlint');
var hljs = require('highlight.js')
var server = require('gulp-server-livereload');
var sass = require('gulp-sass');
var minify = require('gulp-cssnano');
var del = require('del');
var path = require('path');
var mkdirp = require('mkdirp');
var slugify = require('slugify');
var through = require('through2');
var File = require('vinyl');
var print = require('gulp-print');

const fs = require('fs');

var hljs = require('highlight.js');
var frontmatter = require('front-matter');
var markdown = require('markdown-it');
var md_attrs = require('markdown-it-attrs');
var md_container = require('markdown-it-container');
var md_deflist = require('markdown-it-deflist')
var md_sub = require('markdown-it-sub');
var md_sup = require('markdown-it-sup');
var md_katex = require('markdown-it-katex');

var exec = require('child_process');

// hljs lua highlight patched
var lua = require('./lib/lua');
hljs.registerLanguage('lua', lua.lua);

md = new markdown({
  html: true,
  xhtmlOut: true,
  breaks: false,
  langPrefix: 'language-',
  linkify: true,
  typographer: true,
  highlight: function (str, lang) {
    if (lang && hljs.getLanguage(lang)) {
      try {
        var hl = hljs.highlight(lang, str).value;
        // Callouts hack!
        return hl.replace(/(?:--|\/\/|#) &lt;([0-9]+)&gt;/g, '<span class="callout" data-pseudo-content="$1"></span>');
      } catch (__) {}
    }
    return ''; // use external default escaping
  }});

md.use(md_deflist);
md.use(md_attrs);
md.use(md_sub);
md.use(md_sup);
md.use(md_katex);
md.use(md_container, 'sidenote', { render: rendernote });
md.use(md_container, 'important', { render: rendernote });

// Notes are rendered as two divs so they can be styled right
function rendernote(tokens, idx) {
    if (tokens[idx].nesting === 1) {
      // opening tag
      var type = tokens[idx].info.trim().match(/^(\w+).*$/)[1];
      return '<div class="note ' + type + '"><div class="note-icon"></div><div class="note-content">';
    } else {
      // closing tag
      return '</div></div>\n';
    }
};

function slugname(str) {
    return '_' + slugify(str, '_').toLowerCase();
}

// Add anchors to all headings.
md.renderer.rules.heading_open = function (tokens, idx, options, env, self) {
    var tag = tokens[idx].tag;
    var title = tokens[idx + 1].content
    var slug = slugname(title);
    // Add TOC entry
    if(!("toc" in env) ) {
        env.toc = [];
    }
    var level = tag.match(/^h(\d+)$/)[1];
    env.toc.push({ entry: title, slug: slug, level: level });
    return '<div id="' + slug + '" class="anchor"></div>' +
            '<' + tag + '>';
};

md.renderer.rules.heading_close = function (tokens, idx, options, env, self) {
    var slug = slugname(tokens[idx - 1].content);
    var tag = tokens[idx].tag;
    if (tag == 'h2' || tag == 'h3')
        return '<a href="#' + slug + '"><span class="anchor-link"></span></a>\n'
                + '</' + tag + '>';
    else
        return '</' + tag + '>';
};

// Images.
md.renderer.rules.image = function (tokens, idx, options, env, self) {
    var token = tokens[idx];

    if('imgurl' in env) {
        // Rewrite src
        var src = token.attrs[token.attrIndex('src')][1];
        token.attrs[token.attrIndex('src')][1] = env.imgurl + '/' + src;
    }
    // Set alt attribute
    token.attrs[token.attrIndex('alt')][1] = self.renderInlineAsText(token.children, options, env);

    return self.renderToken(tokens, idx, options);
};

// Charts
var default_fence_rule = md.renderer.rules.fence;
md.renderer.rules.fence = function (tokens, idx, options, env, self) {
    var token = tokens[idx];

    if (token.info === 'linechart') {
        const code = token.content.trim();
        const svg = exec.execFileSync('node', ['svg_chart.js'], { input: code });
        return '<div class="ct-chart ct-golden-section">' + svg + '</div>';
    }
    return default_fence_rule(tokens, idx, options, env, self);
}

// Output preview html documents
function markdownToPreviewHtml(file) {
    var data = frontmatter(file.contents.toString());
    // Inject some styling html for the preview. The built htmls are clean.
    var head = '<!DOCTYPE html><html><head><link type="text/css" rel="stylesheet" href="/preview-md.css"></head><body>\n';
    head += '<div class="documentation">';
    var foot = '</div></body></html>\n';
    var html = head + md.render(data.body) + foot;
    file.contents = new Buffer(html);
    file.path = gutil.replaceExtension(file.path, '.html');
    return;
}

var img_url = 'https://storage.googleapis.com/defold-doc';
//var img_url = '/_ah/gcs/defold-doc'; // local dev-server

// Build document json for storage
function markdownToJson(file) {
    var name = path.relative(file.base, file.path);
    // Needs language for static image url:s
    var m = name.match(/^(\w+)[/](\w+)[/].*$/);
    var lang = m[1];
    var doctype = m[2];
    var data = frontmatter(file.contents.toString());
    var env = { imgurl: img_url + '/' + lang + '/' + doctype };
    data.html = md.render(data.body, env);
    data.toc = env.toc;
    file.contents = new Buffer(JSON.stringify(data));
    file.path = gutil.replaceExtension(file.path, '.json');
    return;
}

// Create a map path -> [lang1, lang2 ...] and add it to the
// languages.json file
function langMap(jsonfile) {
    var langmap = require('./docs/' + jsonfile);
    langmap['filemap'] = {};
    return through.obj(function (file, enc, cb) {
            var fullpath = path.relative(file.base, file.path);
            var m = fullpath.match(/^(\w+)[/](\w+)[/].*$/);
            var lang = m[1];
            var name = path.relative(lang, fullpath);
            if(!langmap['filemap'][name]) {
                langmap['filemap'][name] = [];
            }
            langmap['filemap'][name].push(lang);
            cb(null, file);
        }, function(cb) {
            f = new File({
                path: jsonfile,
                contents: new Buffer(JSON.stringify(langmap))
                });
            this.push(f);
            cb();
        });
}

// Build docs
gulp.task('build', ['assets'], function () {
    gulp.src('docs/**/*.md')
        .pipe(tap(markdownToJson))
        .pipe(langMap('languages.json'))
        .pipe(gulp.dest("build"))
        .pipe(preservetime());;

    // jsonfiles directly in lang folders are verified
    return gulp.src(['docs/*/*.json'])
        .pipe(jsonlint())
        .pipe(jsonlint.reporter())
        .pipe(gulp.dest("build"))
        .pipe(preservetime());;
});

gulp.task('assets', ['clean'], function() {
    gulp.src(['docs/assets/**/*.*'])
        .pipe(gulp.dest("build/assets"))
        .pipe(preservetime());

    return gulp.src(['docs/**/*.{png,jpg,svg,gif,js,zip,js}'])
        .pipe(gulp.dest("build"))
        .pipe(preservetime());
});

// Watch for changes in md files and compile new html
gulp.task('watch', function () {
    mkdirp('build/preview');

    gulp.src('build/preview')
        .pipe(server({
            livereload: true,
            open: true,

            directoryListing: {
                enable: true,
                path: 'build/preview'
            }
        }));

    watch(['docs/**/*.sass'], function () {
        gulp.start('sass');
    });

    gulp.start('sass');

    gulp.src('docs/**/images/**/*.*')
        .pipe(watch('docs/**/images/**/*.*'))
        .pipe(gulp.dest("build/preview"));

    return gulp.src('docs/**/*.md')
        .pipe(watch('docs/**/*.md'))
        .pipe(tap(markdownToPreviewHtml))
        .pipe(print())
        .pipe(gulp.dest("build/preview"));
});

gulp.task('clean', [], function() {
    return del(['build']);
});

gulp.task('sass', [], function() {
    gulp.src('docs/sass/preview-md.sass')
        .pipe(plumber())
        .pipe(sass())
        .pipe(minify())
        .pipe(gulp.dest('build/preview'))
});
