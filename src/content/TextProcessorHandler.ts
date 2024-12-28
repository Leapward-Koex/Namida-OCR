export class TextProcessorHandler {
    public static removeSpaces(textWithSpace: String) {
        if (textWithSpace) {
            return textWithSpace.replace(/ /g, '');
        }
        return textWithSpace;
    }
}