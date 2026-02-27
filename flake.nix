{
  description = "Pi Orchestrator - TypeScript development environment";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; };
      in
      {
        devShells.default = pkgs.mkShell {
          buildInputs = with pkgs; [
            nodejs_22
            corepack_22
            typescript
            nodePackages.typescript-language-server
          ];

          shellHook = ''
            echo "Node.js $(node --version) | TypeScript $(tsc --version)"
          '';
        };
      }
    );
}
