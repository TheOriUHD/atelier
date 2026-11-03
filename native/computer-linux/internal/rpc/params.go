package rpc

import (
	"bytes"
	"encoding/json"
	"math"
	"strings"
)

// Params are a request's params object, read field by field: a required field that is missing, null or of the wrong
// type is InvalidParams (like the Swift helper's Decodable params), and unknown fields are ignored.
type Params struct {
	fields map[string]json.RawMessage
	// path is where this object sits ("" at the top, "from." inside `from`), for the messages.
	path string
}

// ParseParams reads `params`: absent or null is `{}`, an object is itself, anything else is InvalidParams.
func ParseParams(raw json.RawMessage) (Params, *Error) {
	if isNull(raw) {
		return Params{fields: map[string]json.RawMessage{}}, nil
	}
	t := bytes.TrimSpace(raw)
	if t[0] != '{' {
		return Params{}, InvalidParams("params must be an object")
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(t, &fields); err != nil {
		return Params{}, InvalidParams("params must be an object")
	}
	return Params{fields: fields}, nil
}

// MustParams builds Params from JSON text (tests).
func MustParams(text string) Params {
	p, err := ParseParams(json.RawMessage(text))
	if err != nil {
		panic(err)
	}
	return p
}

func (p Params) name(field string) string { return p.path + field }

func (p Params) missing(field string) *Error {
	return InvalidParams("invalid params: missing %s", p.name(field))
}

func (p Params) wrong(field, what string, null bool) *Error {
	if null {
		return InvalidParams("invalid params: %s must be %s, not null", p.name(field), what)
	}
	return InvalidParams("invalid params: %s must be %s", p.name(field), what)
}

// raw is a field's value: ok false when it is absent; null reports a JSON null.
func (p Params) raw(field string) (value json.RawMessage, ok bool, null bool) {
	v, ok := p.fields[field]
	if !ok {
		return nil, false, false
	}
	return v, true, isNull(v)
}

// Has reports a field that is present and not null.
func (p Params) Has(field string) bool {
	_, ok, null := p.raw(field)
	return ok && !null
}

func (p Params) number(field string) (float64, bool, *Error) {
	v, ok, null := p.raw(field)
	if !ok {
		return 0, false, nil
	}
	if null {
		return 0, true, p.wrong(field, "a number", true)
	}
	var n float64
	if bytes.TrimSpace(v)[0] == '"' || json.Unmarshal(v, &n) != nil {
		return 0, true, p.wrong(field, "a number", false)
	}
	return n, true, nil
}

// Float is a required number.
func (p Params) Float(field string) (float64, error) {
	n, ok, err := p.number(field)
	if err != nil {
		return 0, err
	}
	if !ok {
		return 0, p.missing(field)
	}
	return n, nil
}

// OptFloat is an optional number: ok false when absent or null.
func (p Params) OptFloat(field string) (n float64, ok bool, err error) {
	if !p.Has(field) {
		return 0, false, nil
	}
	n, _, e := p.number(field)
	if e != nil {
		return 0, false, e
	}
	return n, true, nil
}

func integral(n float64) bool {
	return n == math.Trunc(n) && math.Abs(n) <= float64(math.MaxInt32)*1024
}

// Int is a required integer.
func (p Params) Int(field string) (int, error) {
	n, err := p.Float(field)
	if err != nil {
		return 0, err
	}
	if !integral(n) {
		return 0, p.wrong(field, "an integer", false)
	}
	return int(n), nil
}

// OptInt is an optional integer.
func (p Params) OptInt(field string) (int, bool, error) {
	n, ok, err := p.OptFloat(field)
	if err != nil || !ok {
		return 0, ok, err
	}
	if !integral(n) {
		return 0, false, p.wrong(field, "an integer", false)
	}
	return int(n), true, nil
}

// Bool is a required boolean.
func (p Params) Bool(field string) (bool, error) {
	v, ok, null := p.raw(field)
	if !ok {
		return false, p.missing(field)
	}
	if null {
		return false, p.wrong(field, "a boolean", true)
	}
	var b bool
	if json.Unmarshal(v, &b) != nil {
		return false, p.wrong(field, "a boolean", false)
	}
	return b, nil
}

// String is a required string.
func (p Params) String(field string) (string, error) {
	v, ok, null := p.raw(field)
	if !ok {
		return "", p.missing(field)
	}
	if null {
		return "", p.wrong(field, "a string", true)
	}
	var s string
	if json.Unmarshal(v, &s) != nil {
		return "", p.wrong(field, "a string", false)
	}
	return s, nil
}

// Enum is a required string that must be one of `allowed`.
func (p Params) Enum(field string, allowed ...string) (string, error) {
	s, err := p.String(field)
	if err != nil {
		return "", err
	}
	for _, a := range allowed {
		if s == a {
			return s, nil
		}
	}
	return "", InvalidParams("invalid params: %s must be one of %s, not %q", p.name(field), strings.Join(allowed, ", "), s)
}

func (p Params) strings(field string) ([]string, *Error) {
	v, _, _ := p.raw(field)
	var list []string
	if bytes.TrimSpace(v)[0] != '[' || json.Unmarshal(v, &list) != nil {
		return nil, p.wrong(field, "an array of strings", false)
	}
	if list == nil {
		list = []string{}
	}
	return list, nil
}

// Strings is a required array of strings.
func (p Params) Strings(field string) ([]string, error) {
	_, ok, null := p.raw(field)
	if !ok {
		return nil, p.missing(field)
	}
	if null {
		return nil, p.wrong(field, "an array of strings", true)
	}
	list, err := p.strings(field)
	if err != nil {
		return nil, err
	}
	return list, nil
}

// OptStrings is an optional array of strings: ok false when absent or null.
func (p Params) OptStrings(field string) ([]string, bool, error) {
	if !p.Has(field) {
		return nil, false, nil
	}
	list, err := p.strings(field)
	if err != nil {
		return nil, false, err
	}
	return list, true, nil
}

func (p Params) object(field string) (Params, *Error) {
	v, _, _ := p.raw(field)
	if bytes.TrimSpace(v)[0] != '{' {
		return Params{}, p.wrong(field, "an object", false)
	}
	var fields map[string]json.RawMessage
	if json.Unmarshal(v, &fields) != nil {
		return Params{}, p.wrong(field, "an object", false)
	}
	return Params{fields: fields, path: p.name(field) + "."}, nil
}

// Object is a required object.
func (p Params) Object(field string) (Params, error) {
	_, ok, null := p.raw(field)
	if !ok {
		return Params{}, p.missing(field)
	}
	if null {
		return Params{}, p.wrong(field, "an object", true)
	}
	o, err := p.object(field)
	if err != nil {
		return Params{}, err
	}
	return o, nil
}

// OptObject is an optional object: ok false when absent or null.
func (p Params) OptObject(field string) (Params, bool, error) {
	if !p.Has(field) {
		return Params{}, false, nil
	}
	o, err := p.object(field)
	if err != nil {
		return Params{}, false, err
	}
	return o, true, nil
}
