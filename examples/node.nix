{ pkgs ? import <nixpkgs> { } }:

with pkgs;

let
  inherit (lib) optionals;

  basePackages = [
    git
    nodejs-14_x
    # the default yarn uses the current version of nodejs in <nixpkgs> so we need to tell it to use an older version
    (yarn.override { nodejs = nodejs-14_x; })
    yarn
  ];

  inputs = basePackages ++ optionals stdenv.isLinux inotify-tools
    ++ optionals stdenv.isDarwin (with darwin.apple_sdk.frameworks; [
      # https://github.com/NixOS/nixpkgs/blob/master/pkgs/os-specific/darwin/apple-sdk/frameworks.nix
      CoreFoundation
      CoreServices
    ]);
in mkShell { buildInputs = inputs; }
