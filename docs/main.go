package main

import "fmt"

func test() (i int) {

	defer func() {
		i = i + 1
		fmt.Println("defer2")
	}()
	fmt.Println("defer1")
	return i
}

func main() {

	fmt.Println("return", test())
}
