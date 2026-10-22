package grep

import (
	"maps"
	"slices"
)

// types is a subset of ripgrep's --type table (`rg --type-list`), matched against file names.
var types = map[string][]string{
	"c":        {"*.c", "*.h"},
	"cpp":      {"*.cpp", "*.cc", "*.cxx", "*.c++", "*.hpp", "*.hh", "*.hxx", "*.h", "*.inl"},
	"cs":       {"*.cs"},
	"css":      {"*.css", "*.scss"},
	"dart":     {"*.dart"},
	"docker":   {"Dockerfile", "Dockerfile.*", "*.dockerfile"},
	"go":       {"*.go"},
	"html":     {"*.htm", "*.html", "*.ejs"},
	"java":     {"*.java", "*.jsp"},
	"js":       {"*.js", "*.jsx", "*.mjs", "*.cjs", "*.vue"},
	"json":     {"*.json", "*.sarif"},
	"jsonl":    {"*.jsonl"},
	"kotlin":   {"*.kt", "*.kts"},
	"lua":      {"*.lua"},
	"make":     {"Makefile", "makefile", "GNUmakefile", "*.mk", "*.mak"},
	"markdown": {"*.md", "*.markdown", "*.mdx", "*.mdown", "*.mkd", "*.mkdn"},
	"md":       {"*.md", "*.markdown", "*.mdx", "*.mdown", "*.mkd", "*.mkdn"},
	"php":      {"*.php", "*.php3", "*.php4", "*.php5", "*.phtml"},
	"proto":    {"*.proto"},
	"py":       {"*.py", "*.pyi"},
	"ruby":     {"*.rb", "*.gemspec", "Gemfile", "Rakefile", ".irbrc"},
	"rust":     {"*.rs"},
	"scala":    {"*.scala", "*.sbt"},
	"sh":       {"*.sh", "*.bash", "*.zsh", "*.ksh", ".bashrc", ".bash_profile", ".zshrc", ".profile"},
	"sql":      {"*.sql", "*.psql"},
	"svelte":   {"*.svelte"},
	"swift":    {"*.swift"},
	"toml":     {"*.toml", "Cargo.lock"},
	"ts":       {"*.ts", "*.tsx", "*.cts", "*.mts"},
	"txt":      {"*.txt"},
	"vue":      {"*.vue"},
	"xml":      {"*.xml", "*.xsd", "*.xsl", "*.xslt", "*.dtd", "*.xhtml"},
	"yaml":     {"*.yaml", "*.yml"},
	"zig":      {"*.zig"},
}

func typeNames() []string { return slices.Sorted(maps.Keys(types)) }
