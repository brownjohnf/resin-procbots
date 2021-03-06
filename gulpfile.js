const gulp = require('gulp');
const gutil = require('gulp-util');
const typescript = require('gulp-typescript');
const sourcemaps = require('gulp-sourcemaps');
const tslint = require('gulp-tslint');
const tsProject = typescript.createProject('tsconfig.json');

const OPTIONS = {
    files: {
        declarations: [ 'lib/**/*.d.ts' ]
    }
}

// Compile the TS sources
gulp.task('typescript', () => {
    tsProject.src()
        .pipe(sourcemaps.init())
        .pipe(tsProject()).on('error', gutil.log)
        .pipe(sourcemaps.write('./', { includeContent: true,
            sourceRoot: '../lib'
        }))
        .pipe(gulp.dest('build/'));
});

// Copy any pre-defined declarations
gulp.task('copydecs', () => {
    gulp.src(OPTIONS.files.declarations)
        .pipe(gulp.dest('build/'));
});

gulp.task('tslint', () =>
    tsProject.src()
        .pipe(tslint({
            configuration: 'tslint.json',
            formatter: 'prose'
        }))
        .pipe(tslint.report())
);

gulp.task('build', [ 'typescript', 'copydecs' ]);

