"use strict";
const Promise = require("bluebird");
const ChildProcess = require("child_process");
const FS = require("fs");
const _ = require("lodash");
const path = require("path");
const temp_1 = require("temp");
const flowdock_1 = require("../adapters/flowdock");
const GithubBot = require("./githubbot");
const ProcBot = require("./procbot");
const exec = Promise.promisify(ChildProcess.exec);
const fsReadFile = Promise.promisify(FS.readFile);
const fsFileExists = Promise.promisify(FS.stat);
const tempMkdir = Promise.promisify(temp_1.mkdir);
const tempCleanup = Promise.promisify(temp_1.track);
;
const MergeLabel = 'procbots/versionbot/ready-to-merge';
const IgnoreLabel = 'procbots/versionbot/no-checks';
class VersionBot extends GithubBot.GithubBot {
    constructor(integration, name) {
        super(integration, name);
        this.statusChange = (action, data) => {
            const githubApi = this.githubApi;
            const owner = data.name.split('/')[0];
            const repo = data.name.split('/')[1];
            const commitSha = data.sha;
            const branches = data.branches;
            if (data.context === 'Versionist') {
                return Promise.resolve();
            }
            return Promise.map(branches, (branch) => {
                return this.gitCall(githubApi.pullRequests.getAll, {
                    head: `${owner}:${branch.name}`,
                    owner,
                    repo,
                    state: 'open'
                });
            }).then((prs) => {
                let prEvents = [];
                prs = _.flatten(prs);
                _.each(prs, (pullRequest) => {
                    if (pullRequest.head.sha === commitSha) {
                        prEvents.push({
                            action: 'synchronize',
                            pull_request: pullRequest,
                            sender: {
                                login: pullRequest.user.login
                            },
                            type: 'pull_request'
                        });
                    }
                });
                return Promise.map(prEvents, (event) => {
                    return this.checkVersioning(action, event);
                });
            });
        };
        this.checkVersioning = (action, data) => {
            const githubApi = this.githubApi;
            const pr = data.pull_request;
            const head = data.pull_request.head;
            const owner = head.repo.owner.login;
            const name = head.repo.name;
            if ((data.action !== 'opened') && (data.action !== 'synchronize') &&
                (data.action !== 'labeled')) {
                return Promise.resolve();
            }
            this.log(ProcBot.LogLevel.INFO, `${action.name}: checking version for ${owner}/${name}#${pr.number}`);
            return this.gitCall(githubApi.pullRequests.getCommits, {
                owner,
                number: pr.number,
                repo: name,
            }).then((commits) => {
                let changetypeFound = false;
                for (let commit of commits) {
                    const commitMessage = commit.commit.message;
                    const lines = commitMessage.split('\n');
                    const lastLine = _.findLastIndex(lines, (line) => line.match(/^\s*$/));
                    if (lastLine > 0) {
                        lines.splice(0, lastLine);
                        const footer = lines.join('\n');
                        const invalidCommit = !footer.match(/^change-type:\s*(patch|minor|major)\s*$/mi);
                        if (!invalidCommit) {
                            changetypeFound = true;
                            break;
                        }
                    }
                }
                if (changetypeFound) {
                    return this.gitCall(githubApi.repos.createStatus, {
                        context: 'Versionist',
                        description: 'Found a valid Versionist `Change-Type` tag',
                        owner,
                        repo: name,
                        sha: head.sha,
                        state: 'success'
                    });
                }
                this.log(ProcBot.LogLevel.INFO, `${action.name}: No valid 'Change-Type' tag found, failing last commit ` +
                    `for ${owner}/${name}#${pr.number}`);
                return this.gitCall(githubApi.repos.createStatus, {
                    context: 'Versionist',
                    description: 'None of the commits in the PR have a `Change-Type` tag',
                    owner,
                    repo: name,
                    sha: head.sha,
                    state: 'failure'
                }).then(() => {
                    if (data.action === 'opened') {
                        this.gitCall(githubApi.issues.createComment, {
                            body: `@${data.sender.login}, please ensure that at least one commit contains a` +
                                '`Change-Type:` tag.',
                            owner,
                            number: pr.number,
                            repo: name,
                        });
                    }
                });
            }).then(() => {
                return this.gitCall(this.githubApi.issues.getIssueLabels, {
                    number: pr.number,
                    owner,
                    repo: name
                });
            }).then((labels) => {
                if (_.filter(labels, (label) => {
                    return label.name === MergeLabel;
                }).length !== 0) {
                    return this.gitCall(githubApi.pullRequests.get, {
                        number: pr.number,
                        owner,
                        repo: name
                    }).then((mergePr) => {
                        return this.finaliseMerge(data, mergePr);
                    });
                }
            }).catch((err) => {
                this.reportError({
                    brief: `${process.env.VERSIONBOT_NAME} check failed for ${owner}/${name}#${pr.number}`,
                    message: `${process.env.VERSIONBOT_NAME} failed to carry out a status check for the above pull ` +
                        `request here: ${pr.html_url}. The reason for this is:\r\n${err.message}\r\n` +
                        'Please carry out relevant changes or alert an appropriate admin.',
                    owner,
                    number: pr.number,
                    repo: name
                });
            });
        };
        this.mergePR = (action, data) => {
            const githubApi = this.githubApi;
            const pr = data.pull_request;
            const head = data.pull_request.head;
            const owner = head.repo.owner.login;
            const repo = head.repo.name;
            const repoFullName = `${owner}/${repo}`;
            let newVersion;
            let fullPath;
            let branchName;
            let prInfo;
            let botConfig;
            switch (data.action) {
                case 'submitted':
                case 'labeled':
                    break;
                default:
                    this.log(ProcBot.LogLevel.DEBUG, `${action.name}:${data.action} isn't a useful action`);
                    return Promise.resolve();
            }
            this.log(ProcBot.LogLevel.INFO, `${action.name}: Attempting merge for ${owner}/${repo}#${pr.number}`);
            this.log(ProcBot.LogLevel.INFO, `${action.name}: PR is ready to merge, attempting to carry out a ` +
                `version up for ${owner}/${repo}#${pr.number}`);
            return this.getConfiguration(owner, repo).then((config) => {
                botConfig = config;
                return this.gitCall(githubApi.pullRequests.get, {
                    number: pr.number,
                    owner,
                    repo
                });
            }).then((prData) => {
                prInfo = prData;
                branchName = prInfo.head.ref;
                if (prInfo.mergeable !== true) {
                    throw new Error('The branch cannot currently be merged into master. It has a state of: ' +
                        `\`${prInfo.mergeable_state}\``);
                }
                return this.checkStatuses(prInfo);
            }).then((statusesPassed) => {
                if (!statusesPassed) {
                    throw new Error(`At least one status check has failed; ${process.env.VERSIONBOT_NAME} will not ` +
                        'proceed to update this PR unless forced by re-applying the ' +
                        `\`${MergeLabel}\` label`);
                }
                return this.getVersionBotCommits(prInfo);
            }).then((commitMessage) => {
                if (commitMessage) {
                    throw new Error(`alreadyCommitted`);
                }
                if ((data.action === 'labeled') && (data.type === 'pull_request')) {
                    this.checkValidMaintainer(botConfig, data);
                }
                return tempMkdir(`${repo}-${pr.number}_`);
            }).then((tempDir) => {
                fullPath = `${tempDir}${path.sep}`;
                return this.applyVersionist({
                    action,
                    fullPath,
                    branchName,
                    repoFullName
                });
            }).then((versionData) => {
                if (!versionData.version || !versionData.files) {
                    throw new Error('Could not find new version!');
                }
                newVersion = versionData.version;
                return Promise.map(versionData.files, (file) => {
                    return fsReadFile(`${fullPath}${file}`).call(`toString`, 'base64')
                        .then((encoding) => {
                        let newFile = {
                            file,
                            encoding,
                        };
                        return newFile;
                    });
                });
            }).then((files) => {
                return this.createCommitBlobs({
                    owner,
                    repo,
                    branchName,
                    version: newVersion,
                    files
                });
            }).then(() => {
                return tempCleanup();
            }).then(() => {
                this.log(ProcBot.LogLevel.INFO, `${action.name}: Upped version of ${repoFullName}#${pr.number} to ` +
                    `${newVersion}; tagged and pushed.`);
            }).catch((err) => {
                if (err.message !== 'alreadyCommitted') {
                    this.reportError({
                        brief: `${process.env.VERSIONBOT_NAME} failed to merge ${repoFullName}#${pr.number}`,
                        message: `${process.env.VERSIONBOT_NAME} failed to commit a new version to prepare a merge for ` +
                            `the above pull request here: ${pr.html_url}. The reason for this is:\r\n${err.message}\r\n` +
                            'Please carry out relevant changes or alert an appropriate admin.',
                        owner,
                        number: pr.number,
                        repo
                    });
                }
            });
        };
        this.finaliseMerge = (data, prInfo) => {
            const owner = prInfo.head.repo.owner.login;
            const repo = prInfo.head.repo.name;
            return this.checkStatuses(prInfo).then((statusesPassed) => {
                if (statusesPassed) {
                    return this.getVersionBotCommits(prInfo).then((commitMessage) => {
                        if (commitMessage) {
                            return this.getConfiguration(owner, repo).then((config) => {
                                if (data.action === 'labeled') {
                                    this.checkValidMaintainer(config, data);
                                }
                                return this.mergeToMaster({
                                    commitVersion: commitMessage,
                                    owner,
                                    prNumber: prInfo.number,
                                    repoName: repo
                                });
                            }).then(() => {
                                if (process.env.VERSIONBOT_FLOWDOCK_ROOM) {
                                    const flowdockMessage = {
                                        content: `${process.env.VERSIONBOT_NAME} has now merged the above PR, located ` +
                                            `here: ${prInfo.html_url}.`,
                                        from_address: process.env.VERSIONBOT_EMAIL,
                                        roomId: process.env.VERSIONBOT_FLOWDOCK_ROOM,
                                        source: process.env.VERSIONBOT_NAME,
                                        subject: `${process.env.VERSIONBOT_NAME} merged ${owner}/${repo}#${prInfo.number}`
                                    };
                                    this.flowdock.postToInbox(flowdockMessage);
                                }
                                this.log(ProcBot.LogLevel.INFO, `MergePR: Merged ${owner}/${repo}#${prInfo.number}`);
                            });
                        }
                    });
                }
            });
        };
        _.forEach([
            {
                events: ['pull_request'],
                name: 'CheckVersionistCommitStatus',
                suppressionLabels: [IgnoreLabel],
                workerMethod: this.checkVersioning
            },
            {
                events: ['pull_request', 'pull_request_review'],
                name: 'CheckForReadyMergeState',
                suppressionLabels: [IgnoreLabel],
                triggerLabels: [MergeLabel],
                workerMethod: this.mergePR,
            },
            {
                events: ['status'],
                name: 'StatusChangeState',
                suppressionLabels: [IgnoreLabel],
                triggerLabels: [MergeLabel],
                workerMethod: this.statusChange
            }
        ], (reg) => {
            this.registerAction(reg);
        });
        if (process.env.VERSIONBOT_FLOWDOCK_ROOM) {
            this.flowdock = new flowdock_1.FlowdockAdapter();
        }
        this.authenticate();
    }
    applyVersionist(versionData) {
        const cliCommand = (command) => {
            return exec(command, { cwd: versionData.fullPath });
        };
        return Promise.mapSeries([
            `git clone https://${this.authToken}:${this.authToken}@github.com/${versionData.repoFullName} ` +
                `${versionData.fullPath}`,
            `git checkout ${versionData.branchName}`
        ], cliCommand).then(() => {
            return fsFileExists(`${versionData.fullPath}/versionist.conf.js`)
                .return(true)
                .catch((err) => {
                if (err.code !== 'ENOENT') {
                    throw err;
                }
                return false;
            });
        }).then((exists) => {
            let versionistCommand = 'versionist';
            if (exists) {
                versionistCommand = `${versionistCommand} -c versionist.conf.js`;
                this.log(ProcBot.LogLevel.INFO, `${versionData.action.name}: Found an overriding versionist config ` +
                    `for ${versionData.repoFullName}, using that`);
            }
            return Promise.mapSeries([
                versionistCommand,
                'git status -s'
            ], cliCommand);
        }).get(1).then((status) => {
            const moddedFiles = [];
            let changeLines = status.split('\n');
            let changeLogFound = false;
            if (changeLines.length === 0) {
                throw new Error(`Couldn't find any status changes after running 'versionist', exiting`);
            }
            changeLines = _.slice(changeLines, 0, changeLines.length - 1);
            changeLines.forEach((line) => {
                const match = line.match(/^\sM\s(.+)$/);
                if (!match) {
                    throw new Error(`Found a spurious git status entry: ${line.trim()}, abandoning version up`);
                }
                else {
                    if (match[1] !== 'CHANGELOG.md') {
                        moddedFiles.push(match[1]);
                    }
                    else {
                        changeLogFound = true;
                    }
                }
            });
            if (!changeLogFound) {
                throw new Error(`Couldn't find the CHANGELOG.md file, abandoning version up`);
            }
            moddedFiles.push(`CHANGELOG.md`);
            return exec(`cat ${versionData.fullPath}${_.last(moddedFiles)}`).then((contents) => {
                const match = contents.match(/^## (v[0-9]+\.[0-9]+\.[0-9]+).+$/m);
                if (!match) {
                    throw new Error('Cannot find new version for ${repoFullName}-#${pr.number}');
                }
                versionData.version = match[1];
                versionData.files = moddedFiles;
            }).return(versionData);
        });
    }
    createCommitBlobs(repoData) {
        const githubApi = this.githubApi;
        let newTreeSha;
        return this.gitCall(githubApi.gitdata.getTree, {
            owner: repoData.owner,
            repo: repoData.repo,
            sha: repoData.branchName
        }).then((treeData) => {
            return Promise.map(repoData.files, (file) => {
                const treeEntry = _.find(treeData.tree, (entry) => {
                    return entry.path === file.file;
                });
                if (!treeEntry) {
                    throw new Error(`Couldn't find a git tree entry for the file ${file.file}`);
                }
                file.treeEntry = treeEntry;
                return this.gitCall(githubApi.gitdata.createBlob, {
                    content: file.encoding,
                    encoding: 'base64',
                    owner: repoData.owner,
                    repo: repoData.repo
                }).then((blob) => {
                    if (file.treeEntry) {
                        file.treeEntry.sha = blob.sha;
                    }
                }).return(file);
            }).then((blobFiles) => {
                const newTree = [];
                blobFiles.forEach((file) => {
                    newTree.push({
                        mode: file.treeEntry.mode,
                        path: file.treeEntry.path,
                        sha: file.treeEntry.sha,
                        type: 'blob'
                    });
                });
                return this.gitCall(githubApi.gitdata.createTree, {
                    base_tree: treeData.sha,
                    owner: repoData.owner,
                    repo: repoData.repo,
                    tree: newTree
                });
            }).then((newTree) => {
                newTreeSha = newTree.sha;
                return this.gitCall(githubApi.repos.getCommit, {
                    owner: repoData.owner,
                    repo: repoData.repo,
                    sha: `${repoData.branchName}`
                });
            }).then((lastCommit) => {
                return this.gitCall(githubApi.gitdata.createCommit, {
                    committer: {
                        email: process.env.VERSIONBOT_EMAIL,
                        name: process.env.VERSIONBOT_NAME
                    },
                    message: `${repoData.version}`,
                    owner: repoData.owner,
                    parents: [lastCommit.sha],
                    repo: repoData.repo,
                    tree: newTreeSha
                });
            }).then((commit) => {
                return this.gitCall(githubApi.gitdata.updateReference, {
                    force: false,
                    owner: repoData.owner,
                    ref: `heads/${repoData.branchName}`,
                    repo: repoData.repo,
                    sha: commit.sha
                });
            });
        });
    }
    mergeToMaster(data) {
        const githubApi = this.githubApi;
        return this.gitCall(githubApi.pullRequests.merge, {
            commit_title: `Auto-merge for PR ${data.prNumber} via ${process.env.VERSIONBOT_NAME}`,
            number: data.prNumber,
            owner: data.owner,
            repo: data.repoName
        }, 3).then((mergedData) => {
            return this.gitCall(githubApi.gitdata.createTag, {
                message: data.commitVersion,
                object: mergedData.sha,
                owner: data.owner,
                repo: data.repoName,
                tag: data.commitVersion,
                tagger: {
                    email: process.env.VERSIONBOT_EMAIL,
                    name: process.env.VERSIONBOT_NAME
                },
                type: 'commit'
            });
        }).then((newTag) => {
            return this.gitCall(githubApi.gitdata.createReference, {
                owner: data.owner,
                ref: `refs/tags/${data.commitVersion}`,
                repo: data.repoName,
                sha: newTag.sha
            });
        }).then(() => {
            return this.gitCall(githubApi.issues.removeLabel, {
                name: MergeLabel,
                number: data.prNumber,
                owner: data.owner,
                repo: data.repoName
            });
        }).then(() => {
            return this.gitCall(githubApi.pullRequests.get, {
                number: data.prNumber,
                owner: data.owner,
                repo: data.repoName
            });
        }).then((prInfo) => {
            const branchName = prInfo.head.ref;
            return this.gitCall(githubApi.gitdata.deleteReference, {
                owner: data.owner,
                ref: `heads/${branchName}`,
                repo: data.repoName
            });
        });
    }
    checkStatuses(prInfo) {
        const githubApi = this.githubApi;
        const owner = prInfo.head.repo.owner.login;
        const repo = prInfo.head.repo.name;
        const branch = prInfo.head.ref;
        let contexts = [];
        let foundStatuses = [];
        return this.gitCall(githubApi.repos.getProtectedBranchRequiredStatusChecks, {
            branch: 'master',
            owner,
            repo
        }).then((statusContexts) => {
            contexts = statusContexts.contexts;
            return this.gitCall(githubApi.repos.getCombinedStatus, {
                owner,
                ref: branch,
                repo
            });
        }).then((statuses) => {
            _.each(statuses.statuses, (status) => {
                if (_.includes(contexts, status.context)) {
                    if (status.state === 'success') {
                        foundStatuses.push(true);
                    }
                    else {
                        foundStatuses.push(false);
                    }
                }
            });
            if ((foundStatuses.length !== contexts.length) ||
                _.includes(foundStatuses, false)) {
                return false;
            }
            return true;
        });
    }
    getVersionBotCommits(prInfo) {
        const githubApi = this.githubApi;
        const owner = prInfo.head.repo.owner.login;
        const repo = prInfo.head.repo.name;
        return this.gitCall(githubApi.repos.getCommit, {
            owner,
            repo,
            sha: prInfo.head.sha
        }).then((headCommit) => {
            const commit = headCommit.commit;
            const files = headCommit.files;
            if ((commit.committer.name === process.env.VERSIONBOT_NAME) &&
                _.find(files, (file) => {
                    return file.filename === 'CHANGELOG.md';
                })) {
                return commit.message;
            }
            return null;
        });
    }
    checkValidMaintainer(config, event) {
        const maintainers = ((((config || {}).procbot || {}).githubbot || {}).versionbot || {}).maintainers;
        if (maintainers) {
            if (!_.includes(maintainers, event.sender.login)) {
                let errorMessage = `The \`${MergeLabel}\` label was not added by an authorised ` +
                    'maintainer. Authorised maintainers are:\n';
                _.each(maintainers, (maintainer) => errorMessage = errorMessage.concat(`* @${maintainer}\n`));
                throw new Error(errorMessage);
            }
        }
    }
    getConfiguration(owner, repo) {
        return this.retrieveGithubConfiguration(owner, repo).then((configuration) => {
            return configuration;
        }).catch((err) => {
            const errMessage = JSON.parse(err.message);
            if (errMessage.message !== 'Not Found') {
                throw err;
            }
        });
    }
    reportError(error) {
        const githubApi = this.githubApi;
        if (process.env.VERSIONBOT_FLOWDOCK_ROOM) {
            const flowdockMessage = {
                content: error.message,
                from_address: process.env.VERSIONBOT_EMAIL,
                roomId: process.env.VERSIONBOT_FLOWDOCK_ROOM,
                source: process.env.VERSIONBOT_NAME,
                subject: error.brief,
                tags: ['devops']
            };
            this.flowdock.postToInbox(flowdockMessage);
        }
        this.gitCall(githubApi.issues.createComment, {
            body: error.message,
            number: error.number,
            owner: error.owner,
            repo: error.repo
        });
        this.alert(ProcBot.AlertLevel.ERROR, error.message);
    }
}
exports.VersionBot = VersionBot;
function createBot() {
    if (!(process.env.VERSIONBOT_NAME && process.env.VERSIONBOT_EMAIL)) {
        throw new Error(`'VERSIONBOT_NAME' and 'VERSIONBOT_EMAIL' environment variables need setting`);
    }
    return new VersionBot(process.env.INTEGRATION_ID, process.env.VERSIONBOT_NAME);
}
exports.createBot = createBot;

//# sourceMappingURL=versionbot.js.map
