#!/usr/bin/env python3
"""Small Hugging Face dataset helper for the weather cut mirror.

The repository is a public dataset. Its layout matches the release layout:
<tag>/manifest.json, <tag>/<field>.wgrz, and latest/latest.json. Authentication
comes from HF_TOKEN and the repository name from HF_MIRROR_REPO; neither value
is printed.
"""

import argparse
import json
import os
import sys

from huggingface_hub import HfApi

REPO_TYPE = "dataset"


def make_api():
    token = os.environ.get("HF_TOKEN")
    if not token:
        raise SystemExit("HF_TOKEN is not set")
    return HfApi(token=token)


def repo_id():
    value = os.environ.get("HF_MIRROR_REPO")
    if not value:
        raise SystemExit("HF_MIRROR_REPO is not set")
    return value


def cmd_list(_args):
    files = make_api().list_repo_files(repo_id=repo_id(), repo_type=REPO_TYPE)
    folders = sorted({name.split("/", 1)[0] for name in files if "/" in name})
    print(json.dumps(folders))


def cmd_upload_folder(args):
    make_api().upload_folder(
        repo_id=repo_id(),
        repo_type=REPO_TYPE,
        folder_path=args.folder,
        path_in_repo=args.tag,
        commit_message="Add model run " + args.tag,
    )
    print(json.dumps({"uploaded": args.tag}))


def cmd_upload_file(args):
    make_api().upload_file(
        repo_id=repo_id(),
        repo_type=REPO_TYPE,
        path_or_fileobj=args.local,
        path_in_repo=args.path_in_repo,
        commit_message="Update latest pointer",
    )
    print(json.dumps({"uploaded": args.path_in_repo}))


def cmd_delete_folder(args):
    make_api().delete_folder(
        repo_id=repo_id(),
        repo_type=REPO_TYPE,
        path_in_repo=args.tag,
        commit_message="Remove expired model run " + args.tag,
    )
    print(json.dumps({"removed": args.tag}))


def cmd_squash(args):
    # Deleted files stay in the repository history and keep counting toward
    # storage; squashing the history frees them.
    make_api().super_squash_history(repo_id=repo_id(), repo_type=REPO_TYPE)
    print(json.dumps({"squashed": True}))


def build_parser():
    parser = argparse.ArgumentParser(description="Weather cut mirror helper")
    sub = parser.add_subparsers(dest="command", required=True)

    listing = sub.add_parser("list", help="print the top-level folder names")
    listing.set_defaults(func=cmd_list)

    folder = sub.add_parser("upload-folder", help="upload one model-run folder")
    folder.add_argument("--tag", required=True)
    folder.add_argument("--folder", required=True)
    folder.set_defaults(func=cmd_upload_folder)

    single = sub.add_parser("upload-file", help="upload one file")
    single.add_argument("--local", required=True)
    single.add_argument("--path-in-repo", required=True)
    single.set_defaults(func=cmd_upload_file)

    delete = sub.add_parser("delete-folder", help="delete one model-run folder")
    delete.add_argument("--tag", required=True)
    delete.set_defaults(func=cmd_delete_folder)

    squash = sub.add_parser("squash", help="drop old history so deleted files free their space")
    squash.set_defaults(func=cmd_squash)

    return parser


def main(argv=None):
    args = build_parser().parse_args(argv)
    args.func(args)


if __name__ == "__main__":
    main(sys.argv[1:])
